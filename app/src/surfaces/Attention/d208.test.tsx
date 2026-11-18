/**
 * D208 (owner, 18.11.2026): the calm Vorschlag row and its open line, rendered from canned engine answers.
 * Every assertion is about what the row shows and which verbs it sends:
 *
 *  - the row: the plus of incoming money in the success ink, the minus of outgoing money in the danger ink,
 *    the source glyph (a rule's filled star with its name and since when in the tooltip), no certainty dots;
 *  - the open line: unchanged, the commit is Freigeben (`approve_drafted_action`); changed, it is Buchen
 *    (`book_bank_line` with the person's text and account, the draft's own target otherwise, ONE key per
 *    click); the star saves the rule after the booking, an EDITED booking text as the leg's description
 *    and the comment to the agent as `note` (only when edited);
 *  - the missing-Beleg hint (`attention.row_hints`), Rückgängig after an approval (`reopen_bank_line`), and the
 *    keys F and R (`attention.keys`).
 *
 * SYNTHETIC BY CONSTRUCTION: invented counterparties and amounts; the accounts are the pinned
 * `list_accounts` recording.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { resetPrefsModuleForTests } from '../../lib/prefs';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import { Attention } from './index';
import { bankVorschlag, draftedBankLine, groupedOf } from './testing';

type Handler = (input: Record<string, unknown>) => RestResponse | Promise<RestResponse>;
type Canned = Record<string, RestResponse | Handler>;
type Call = { action: string; input: Record<string, unknown> };

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

/** D210: where a door led (any route but Pendenzen). */
function Where() {
  const { pathname, search } = useLocation();
  return <p data-testid="where">{`${pathname}${search}`}</p>;
}

function renderHub(canned: Canned) {
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
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter initialEntries={['/attention']}>
            <Routes>
              <Route path="/attention" element={<Attention />} />
              <Route path="*" element={<Where />} />
            </Routes>
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
  return { calls };
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

const OUT = draftedBankLine('a1', 'Lastschrift PAPETERIE SONNHALDE 12.11', -4870);
const OUT_ROW = bankVorschlag('a1', {
  subtitleParams: { tool: 'book_bank_line', date: '2026-11-12', target: '6570 Informatik, Software und Lizenzen', targetKind: 'accounts', counterparty: 'Papeterie Sonnhalde GmbH' },
  amountMinor: -4870,
});
const OUT_LINE = { ...OUT, lineFacts: { date: '2026-11-12', counterparty: 'Papeterie Sonnhalde GmbH', text: 'Rechnung 4711', amountMinor: -4870, currency: 'CHF' } };

function world(over: Canned = {}): Canned {
  return {
    attention_list: ok(groupedOf([OUT_ROW], { grouping: 'by_kind' })),
    list_drafted_actions: ok({ actions: [OUT_LINE] }),
    list_accounts: ok({ accounts: listAccountsFixture.accounts }),
    list_bank_inbox: ok({ lines: [{ bankTxnId: 'btx_a1', ruleIds: [], receiptCount: 0, standardId: null, proposal: null }] }),
    list_bank_standards: ok({ standards: [] }),
    vat_codes: ok({ taxCodes: [{ code: 'VST-M', kind: 'input', rateBp: 810, label: 'Vorsteuer Material', active: true, formLine: '400' }] }),
    settings_get: (input) => ok({ setting: { key: input.key, value: input.key === 'attention.auto_rule_confirm' ? 'never' : undefined } }),
    approve_drafted_action: ok({ status: 'executed' }),
    book_bank_line: ok({ state: 'booked', bankTxnId: 'btx_a1', entryId: 'je_1' }),
    set_bank_standard: ok({ standard: { id: 'std_7' }, supersededId: null, unchanged: false, noteChanged: true }),
    reopen_bank_line: ok({ bankTxnId: 'btx_a1' }),
    ...over,
  };
}

const lineEl = () => document.querySelector('.pl') as HTMLElement;
const openLine = async () => {
  await screen.findByText('Papeterie Sonnhalde GmbH');
  await settle();
  fireEvent.click(lineEl().querySelector('button.pl-main') as HTMLElement);
  return lineEl().querySelector('.pl-open') as HTMLElement;
};

beforeEach(() => {
  window.localStorage.clear();
  resetPrefsModuleForTests();
});

describe('D208: the calm row', () => {
  it('one line: counterparty, booking text dim, account, date, the minus in the danger ink; no certainty dots, no lead glyph', async () => {
    renderHub(world());
    await screen.findByText('Papeterie Sonnhalde GmbH');
    await settle();
    const line = lineEl();
    expect(line.querySelector('.pl-dim')?.textContent).toBe('Lastschrift PAPETERIE SONNHALDE 12.11');
    expect(line.querySelector('.pl-account-text')?.textContent).toContain('6570');
    expect(line.querySelector('.pl-amount')?.textContent).toBe('CHF -48.70');
    expect(line.querySelector('.pl-sign--out')?.textContent).toBe('-');
    expect(line.querySelector('.vrow-cert, .att-kind')).toBeNull();
  });

  it('incoming money carries a small plus in the success ink, the figure in ink', async () => {
    const IN = { ...OUT_LINE, lineFacts: { ...OUT_LINE.lineFacts, amountMinor: 12000 }, payload: { ...(OUT.payload as Record<string, unknown>), target: { kind: 'accounts', legs: [{ accountId: 'acc_30', amountMinor: 12000 }] } } };
    renderHub(world({ list_drafted_actions: ok({ actions: [IN] }), attention_list: ok(groupedOf([{ ...OUT_ROW, amountMinor: 12000 }], { grouping: 'by_kind' })) }));
    await screen.findByText('Papeterie Sonnhalde GmbH');
    await settle();
    expect(lineEl().querySelector('.pl-amount')?.textContent).toBe('CHF +120.00');
    expect(lineEl().querySelector('.pl-sign--in')?.textContent).toBe('+');
  });

  it('a booking from a Buchungsregel shows the filled star, its words in the tooltip only', async () => {
    renderHub(
      world({
        list_bank_inbox: ok({ lines: [{ bankTxnId: 'btx_a1', ruleIds: ['std_3'], receiptCount: 1, standardId: 'std_3', proposal: { reasonCode: 'standard' } }] }),
        list_bank_standards: ok({ standards: [{ id: 'std_3', label: 'Papeterie', counterpartyLabel: 'Papeterie Sonnhalde GmbH', setAt: '2026-10-01T08:00:00.000Z', legs: [{ accountId: 'acc_51', taxCode: null }], note: null }] }),
      }),
    );
    await screen.findByText('Papeterie Sonnhalde GmbH');
    await waitFor(() => expect(lineEl().querySelector('[data-source="rule"]')).not.toBeNull());
    const mark = lineEl().querySelector('[data-source="rule"]') as HTMLElement;
    expect(mark.textContent).toBe('Buchungsregel «Papeterie», seit 01.10.2026');
    expect(mark.querySelector('.visually-hidden')).not.toBeNull();
  });

  it('the missing Beleg on a line that claims Vorsteuer is the paperclip alone; none under attention.row_hints = none', async () => {
    const coded = { ...OUT_LINE, payload: { ...(OUT.payload as Record<string, unknown>), target: { kind: 'accounts', legs: [{ accountId: 'acc_51', amountMinor: -4870, taxCode: 'VST-M' }] } } };
    renderHub(world({ list_drafted_actions: ok({ actions: [coded] }) }));
    await screen.findByText('Papeterie Sonnhalde GmbH');
    const clip = await within(lineEl()).findByRole('button', { name: 'Anhängen' });
    expect(clip).toHaveClass('pl-hint');
    expect(clip.textContent).toBe('');
  });

  it('attention.row_hints = none: no hint', async () => {
    const coded = { ...OUT_LINE, payload: { ...(OUT.payload as Record<string, unknown>), target: { kind: 'accounts', legs: [{ accountId: 'acc_51', amountMinor: -4870, taxCode: 'VST-M' }] } } };
    renderHub(world({ list_drafted_actions: ok({ actions: [coded] }), settings_get: (input) => ok({ setting: { key: input.key, value: input.key === 'attention.row_hints' ? 'none' : 'never' } }) }));
    await screen.findByText('Papeterie Sonnhalde GmbH');
    await settle();
    await settle();
    expect(within(lineEl()).queryByRole('button', { name: 'Anhängen' })).toBeNull();
  });
});

describe('D208: the open line', () => {
  it('unchanged, the commit is Freigeben and sends the approval exactly; Rückgängig reopens the booked line', async () => {
    const { calls } = renderHub(world());
    await openLine();
    fireEvent.click(within(acts()).getByRole('button', { name: 'Freigeben' }));
    expect(await screen.findByText('Vorschlag freigegeben und ausgeführt.')).toBeInTheDocument();
    expect(calls.filter((c) => c.action === 'approve_drafted_action').map((c) => c.input)).toEqual([{ workspaceId: 'ws_test', actionId: 'a1' }]);
    expect(calls.some((c) => c.action === 'book_bank_line')).toBe(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Rückgängig' }));
    await waitFor(() => expect(calls.filter((c) => c.action === 'reopen_bank_line')).toHaveLength(1));
    expect(calls.find((c) => c.action === 'reopen_bank_line')?.input).toMatchObject({ workspaceId: 'ws_test', bankTxnId: 'btx_a1' });
  });

  it('a changed booking text: the commit is Buchen and books the line with the text and the draft\'s own target, under one key', async () => {
    const { calls } = renderHub(world());
    const open = await openLine();
    const text = within(open).getByRole('textbox', { name: 'Buchungstext' });
    await userEvent.clear(text);
    await userEvent.type(text, 'Büromaterial Sonnhalde');
    fireEvent.click(within(acts()).getByRole('button', { name: 'Buchen' }));
    expect(await screen.findByText('Gebucht.')).toBeInTheDocument();
    const booked = calls.filter((c) => c.action === 'book_bank_line');
    expect(booked).toHaveLength(1);
    expect(booked[0]?.input).toMatchObject({
      workspaceId: 'ws_test',
      bankTxnId: 'btx_a1',
      text: 'Büromaterial Sonnhalde',
      target: { kind: 'accounts', legs: [{ accountId: 'acc_51', amountMinor: -4870 }] },
    });
    expect(String(booked[0]?.input.idempotencyKey)).toMatch(/^d208-line:a1:/);
    expect(calls.some((c) => c.action === 'approve_drafted_action')).toBe(false);
  });

  it('D210: the row star on the open line: the booking first, then the rule, no note and no description from the unedited text', async () => {
    const { calls } = renderHub(world());
    const open = await openLine();
    // D210: the open line repeats no star, no comment and no commit; the row's trio acts on it.
    expect(within(open).queryByRole('button', { name: 'Als Regel speichern' })).toBeNull();
    expect(within(open).queryByRole('button', { name: 'Kommentieren' })).toBeNull();
    expect(within(open).queryByRole('button', { name: 'Freigeben' })).toBeNull();
    rowStar();
    expect(await screen.findByText('Gebucht. Regel gespeichert.')).toBeInTheDocument();
    const writes = calls.filter((c) => ['approve_drafted_action', 'book_bank_line', 'set_bank_standard'].includes(c.action));
    expect(writes.map((c) => c.action)).toEqual(['approve_drafted_action', 'set_bank_standard']);
    expect(writes[1]?.input).toMatchObject({
      fromBankTxnId: 'btx_a1',
      expectSlotStandardId: null,
      legs: [{ accountId: 'acc_51', taxCode: null, amount: { kind: 'rest' } }],
    });
    expect(writes[1]?.input).not.toHaveProperty('note');
    // Critic D208: the unedited text is the line's own remittance; it never becomes the rule's description.
    expect((writes[1]?.input.legs as Record<string, unknown>[])[0]).not.toHaveProperty('description');
    // The slot was read before anything was booked (critic D207 F3).
    const slotRead = calls.findIndex((c) => c.action === 'list_bank_inbox' && c.input.bankTxnId === 'btx_a1');
    expect(slotRead).toBeGreaterThanOrEqual(0);
    expect(slotRead).toBeLessThan(calls.findIndex((c) => c.action === 'approve_drafted_action'));
  });
});

describe('D208: the keys (attention.keys)', () => {
  it('F approves the row in focus', async () => {
    const { calls } = renderHub(world({ reject_drafted_action: ok({}) }));
    await screen.findByText('Papeterie Sonnhalde GmbH');
    await settle();
    const main = lineEl().querySelector('button.pl-main') as HTMLButtonElement;
    act(() => main.focus());
    fireEvent.keyDown(main, { key: 'f' });
    await waitFor(() => expect(calls.filter((c) => c.action === 'approve_drafted_action')).toHaveLength(1));
  });

  it('off: F does nothing', async () => {
    const { calls } = renderHub(world({ settings_get: (input) => ok({ setting: { key: input.key, value: input.key === 'attention.keys' ? false : 'never' } }) }));
    await screen.findByText('Papeterie Sonnhalde GmbH');
    await settle();
    await settle();
    const main = lineEl().querySelector('button.pl-main') as HTMLButtonElement;
    act(() => main.focus());
    fireEvent.keyDown(main, { key: 'f' });
    await settle();
    expect(calls.filter((c) => c.action === 'approve_drafted_action')).toHaveLength(0);
  });
});

describe('D208: the star says before the click which rule it replaces', () => {
  const slotWorld = (legs: { accountId: string; taxCode: string | null }[]) =>
    world({
      list_bank_inbox: ok({ lines: [{ bankTxnId: 'btx_a1', ruleIds: ['std_9'], receiptCount: 1, standardId: 'std_9', proposal: { reasonCode: 'journal_history' } }] }),
      list_bank_standards: ok({ standards: [{ id: 'std_9', label: 'Papeterie alt', counterpartyLabel: 'Papeterie Sonnhalde GmbH', matchText: null, setAt: '2026-09-01T08:00:00.000Z', legs, note: null }] }),
    });

  it('a different rule in the slot: the row star names it, open or closed, with no extra text on the line', async () => {
    renderHub(slotWorld([{ accountId: 'acc_50', taxCode: null }]));
    await screen.findByText('Papeterie Sonnhalde GmbH');
    const rowStar = await within(lineEl()).findByRole('button', { name: 'Freigeben, ersetzt Regel «Papeterie alt»' });
    expect(rowStar.closest('.tooltip-wrap')?.querySelector('[role="tooltip"] .tooltip-name')?.textContent).toBe('Freigeben, ersetzt Regel «Papeterie alt»');
    fireEvent.click(lineEl().querySelector('button.pl-main') as HTMLElement);
    const open = lineEl().querySelector('.pl-open') as HTMLElement;
    // D210: the open line has no star of its own; the row star keeps its name while the line is open.
    expect(within(open).queryByRole('button', { name: 'Ersetzt Regel «Papeterie alt»' })).toBeNull();
    expect(within(acts()).getByRole('button', { name: 'Freigeben, ersetzt Regel «Papeterie alt»' })).toBeInTheDocument();
    // Said only in the names: the visible line carries no sentence about it, and no confirm opens.
    const visible = [...(lineEl().querySelector('.pl-main')?.childNodes ?? [])].map((n) => n.textContent ?? '').join(' ');
    expect(visible).not.toContain('ersetzt');
    expect(screen.queryByRole('group', { name: 'Freigeben und künftig automatisch' })).toBeNull();
  });

  it('the same booking in the slot: the plain names', async () => {
    renderHub(slotWorld([{ accountId: 'acc_51', taxCode: null }]));
    await screen.findByText('Papeterie Sonnhalde GmbH');
    expect(await within(lineEl()).findByRole('button', { name: 'Freigeben und als Regel speichern' })).toBeInTheDocument();
    fireEvent.click(lineEl().querySelector('button.pl-main') as HTMLElement);
    expect(within(acts()).getByRole('button', { name: 'Freigeben und als Regel speichern' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------------
// Critic D208 (18.11.2026, two non-author critics on 6c28bbeeb)
// ---------------------------------------------------------------------------------------------------

const OLD = {
  id: 'std_9',
  label: 'Papeterie alt',
  counterpartyLabel: 'Papeterie Sonnhalde GmbH',
  matchText: null,
  setAt: '2026-09-01T08:00:00.000Z',
  outcome: 'legs',
  note: 'Alte Notiz.',
  viaAccountId: null,
  followUpStandardId: null,
  legs: [{ accountId: 'acc_50', taxCode: null, amount: { kind: 'rest' } }],
};
/** The list read (open, limit 200) and the click-time read (`bankTxnId`) answer differently. */
const inbox = (listed: string[] | null, now: string[]) => (input: Record<string, unknown>) =>
  input.bankTxnId !== undefined
    ? ok({ lines: [{ bankTxnId: 'btx_a1', ruleIds: now, receiptCount: 1, standardId: null, proposal: null }] })
    : ok({ lines: listed === null ? [] : [{ bankTxnId: 'btx_a1', ruleIds: listed, receiptCount: 1, standardId: null, proposal: null }] });
const writesOf = (calls: Call[]) => calls.filter((c) => ['approve_drafted_action', 'book_bank_line', 'set_bank_standard'].includes(c.action));
/** D210: the row's own trio acts on the open line; the star is one click (the old line star plus its commit). */
const acts = () => lineEl().querySelector('.pl-acts') as HTMLElement;
const rowStar = (name = 'Freigeben und als Regel speichern') => fireEvent.click(within(acts()).getByRole('button', { name }));

describe('critic D208 MEDIUM-1: the star never replaces a rule the person was not shown', () => {
  it('repro 1: the list never held the line (more than 200 open lines): nothing is booked; the rule is named and confirmed, then pinned', async () => {
    const { calls } = renderHub(world({ list_bank_inbox: inbox(null, ['std_9']), list_bank_standards: ok({ standards: [OLD] }) }));
    await openLine();
    rowStar();
    const ask = await screen.findByRole('group', { name: 'Freigeben und künftig automatisch' });
    expect(ask.textContent).toContain('Ersetzt die bestehende Regel: Papeterie alt.');
    expect(writesOf(calls)).toHaveLength(0);
    fireEvent.click(within(ask).getByRole('button', { name: 'Freigeben und Regel speichern' }));
    await waitFor(() => expect(writesOf(calls).map((c) => c.action)).toEqual(['approve_drafted_action', 'set_bank_standard']));
    expect(writesOf(calls)[1]?.input).toMatchObject({ fromBankTxnId: 'btx_a1', expectSlotStandardId: 'std_9', label: 'Papeterie alt' });
  });

  it('repro 2: a rule saved in another tab after the list loaded: nothing is booked until the person confirms it by name', async () => {
    const { calls } = renderHub(world({ list_bank_inbox: inbox([], ['std_9']), list_bank_standards: ok({ standards: [OLD] }) }));
    await openLine();
    rowStar();
    const ask = await screen.findByRole('group', { name: 'Freigeben und künftig automatisch' });
    expect(ask.textContent).toContain('Papeterie alt');
    await settle();
    expect(writesOf(calls)).toHaveLength(0);
    fireEvent.click(within(ask).getByRole('button', { name: 'Abbrechen' }));
    await settle();
    expect(writesOf(calls)).toHaveLength(0);
  });

  it('the slot the person was shown is pinned without a question; a replaced rule\'s old comment goes with it', async () => {
    const { calls } = renderHub(world({ list_bank_inbox: inbox(['std_9'], ['std_9']), list_bank_standards: ok({ standards: [OLD] }) }));
    await openLine();
    rowStar('Freigeben, ersetzt Regel «Papeterie alt»');
    await waitFor(() => expect(writesOf(calls).map((c) => c.action)).toEqual(['approve_drafted_action', 'set_bank_standard']));
    expect(screen.queryByRole('group', { name: 'Freigeben und künftig automatisch' })).toBeNull();
    expect(writesOf(calls)[1]?.input).toMatchObject({ expectSlotStandardId: 'std_9', label: 'Papeterie alt', note: null, legs: [{ accountId: 'acc_51', taxCode: null, amount: { kind: 'rest' } }] });
  });

  it('repro 3: a slot rule with the same booking is kept: its own recipe, name, Durchlaufkonto and next step go back, so the star alone is no new version', async () => {
    const same = {
      ...OLD,
      viaAccountId: 'acc_via',
      followUpStandardId: 'std_v',
      legs: [{ accountId: 'acc_51', taxCode: null, amount: { kind: 'rest' }, description: 'Büromaterial', accountNumber: '6570', accountName: 'Informatik' }],
    };
    const { calls } = renderHub(
      world({
        list_bank_inbox: inbox(['std_9'], ['std_9']),
        list_bank_standards: ok({ standards: [same] }),
        set_bank_standard: ok({ standard: { id: 'std_9' }, supersededId: null, unchanged: true, noteChanged: false }),
      }),
    );
    await openLine();
    // The slot rule books the same: the star keeps its plain name.
    rowStar();
    await waitFor(() => expect(writesOf(calls)).toHaveLength(2));
    expect(writesOf(calls)[1]?.input).toEqual({
      workspaceId: 'ws_test',
      fromBankTxnId: 'btx_a1',
      legs: [{ accountId: 'acc_51', taxCode: null, amount: { kind: 'rest' }, description: 'Büromaterial' }],
      label: 'Papeterie alt',
      followUpStandardId: 'std_v',
      viaAccountId: 'acc_via',
      expectSlotStandardId: 'std_9',
      idempotencyKey: expect.stringMatching(/^d207-rule:btx_a1:/),
    });
  });
});

describe('critic D208: Regel anpassen changes only what the person changed', () => {
  const RULE = {
    id: 'std_3',
    label: 'Papeterie',
    counterpartyLabel: 'Papeterie Sonnhalde GmbH',
    matchText: 'rechnung',
    setAt: '2026-10-01T08:00:00.000Z',
    outcome: 'legs',
    note: 'Immer 6570.',
    viaAccountId: null,
    followUpStandardId: 'std_v',
    legs: [{ accountId: 'acc_51', taxCode: null, amount: { kind: 'rest' }, description: 'Büromaterial' }],
  };
  const ruleWorld = (over: Canned = {}) =>
    world({
      list_bank_inbox: ok({ lines: [{ bankTxnId: 'btx_a1', ruleIds: ['std_3'], receiptCount: 1, standardId: 'std_3', proposal: { reasonCode: 'standard' } }] }),
      list_bank_standards: ok({ standards: [RULE] }),
      set_bank_standard: ok({ standard: { id: 'std_3' }, supersededId: null, unchanged: true, noteChanged: true }),
      ...over,
    });

  it('D210: the star alone sends the rule\'s own recipe, name, text and next step and no note (no new version)', async () => {
    const { calls } = renderHub(ruleWorld());
    const open = await openLine();
    // D210: no comment field in Pendenzen any more (the rule's comment is edited in Bank's rule editor).
    expect(within(open).queryByRole('button', { name: 'Kommentieren' })).toBeNull();
    rowStar('Regel anpassen');
    await waitFor(() => expect(writesOf(calls)).toHaveLength(2));
    expect(writesOf(calls)[1]?.input).toEqual({
      workspaceId: 'ws_test',
      standardId: 'std_3',
      legs: [{ accountId: 'acc_51', taxCode: null, amount: { kind: 'rest' }, description: 'Büromaterial' }],
      label: 'Papeterie',
      followUpStandardId: 'std_v',
      matchText: 'rechnung',
      idempotencyKey: expect.any(String),
    });
  });

  it('LOW-2: the star without touching the comment sends no note (the rule\'s comment stays)', async () => {
    const { calls } = renderHub(ruleWorld({ set_bank_standard: ok({ standard: { id: 'std_3' }, supersededId: null, unchanged: true, noteChanged: false }) }));
    await openLine();
    rowStar('Regel anpassen');
    await waitFor(() => expect(writesOf(calls)).toHaveLength(2));
    expect(writesOf(calls)[1]?.input).not.toHaveProperty('note');
  });

  it('an edited text lands on the rule\'s rest leg and on the booking', async () => {
    const { calls } = renderHub(ruleWorld({ set_bank_standard: ok({ standard: { id: 'std_4' }, supersededId: 'std_3', unchanged: false, noteChanged: false }) }));
    const open = await openLine();
    const text = within(open).getByRole('textbox', { name: 'Buchungstext' });
    await userEvent.clear(text);
    await userEvent.type(text, 'Papeterie');
    rowStar('Regel anpassen');
    await waitFor(() => expect(writesOf(calls)).toHaveLength(2));
    expect(writesOf(calls)[0]?.input).toMatchObject({ text: 'Papeterie' });
    expect(writesOf(calls)[1]?.input).toMatchObject({ standardId: 'std_3', legs: [{ accountId: 'acc_51', amount: { kind: 'rest' }, description: 'Papeterie' }] });
  });
});

describe('critic D208: the open line\'s small things', () => {
  it('LOW-3: an emptied text shows the booked text again on blur', async () => {
    renderHub(world());
    const open = await openLine();
    const text = within(open).getByRole('textbox', { name: 'Buchungstext' });
    await userEvent.clear(text);
    expect(text).toHaveValue('');
    fireEvent.blur(text);
    expect(text).toHaveValue('Lastschrift PAPETERIE SONNHALDE 12.11');
  });

  it('LOW-4: an account the list leaves out and a code the book does not list still show on their triggers', async () => {
    const odd = { ...OUT_LINE, payload: { ...(OUT.payload as Record<string, unknown>), target: { kind: 'accounts', legs: [{ accountId: 'acc_4', amountMinor: -4870, taxCode: 'XYZ' }] } } };
    renderHub(world({ list_drafted_actions: ok({ actions: [odd] }) }));
    const open = await openLine();
    await settle();
    expect(within(open).getByRole('combobox', { name: 'Konto' }).textContent).toContain('1100 Forderungen aus Lieferungen und Leistungen');
    expect(within(open).getByRole('combobox', { name: 'MWST-Code' }).textContent).toContain('XYZ');
  });

  it('4: a refused booking retried with corrected values runs under a new key; the same values keep theirs', async () => {
    let n = 0;
    const { calls } = renderHub(
      world({
        book_bank_line: () => {
          n += 1;
          return n < 3 ? { status: 409, body: { ok: false, error: 'invalid_input' } } : ok({ state: 'booked', bankTxnId: 'btx_a1', entryId: 'je_1' });
        },
      }),
    );
    const open = await openLine();
    const text = within(open).getByRole('textbox', { name: 'Buchungstext' });
    await userEvent.clear(text);
    await userEvent.type(text, 'Erster Versuch');
    fireEvent.click(within(acts()).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(calls.filter((c) => c.action === 'book_bank_line')).toHaveLength(1));
    await settle();
    fireEvent.click(within(acts()).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(calls.filter((c) => c.action === 'book_bank_line')).toHaveLength(2));
    await settle();
    await userEvent.type(text, ' korrigiert');
    fireEvent.click(within(acts()).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(calls.filter((c) => c.action === 'book_bank_line')).toHaveLength(3));
    const keys = calls.filter((c) => c.action === 'book_bank_line').map((c) => c.input.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('5: arrows inside the open line\'s Select move its options, not the rows', async () => {
    const OUT2 = { ...draftedBankLine('a2', 'Lastschrift ZWEITE', -1000), lineFacts: { date: '2026-11-13', counterparty: 'Zweite AG', text: 'Z', amountMinor: -1000, currency: 'CHF' } };
    const ROW2 = bankVorschlag('a2', { subtitleParams: { tool: 'book_bank_line', date: '2026-11-13', target: '6570', targetKind: 'accounts', counterparty: 'Zweite AG' }, amountMinor: -1000 });
    renderHub(world({ attention_list: ok(groupedOf([OUT_ROW, ROW2], { grouping: 'by_kind' })), list_drafted_actions: ok({ actions: [OUT_LINE, OUT2] }) }));
    const open = await openLine();
    const combo = within(open).getByRole('combobox', { name: 'Konto' });
    act(() => combo.focus());
    fireEvent.keyDown(combo, { key: 'ArrowDown' });
    fireEvent.keyDown(combo, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(combo);
  });

  it('6: F on a row whose open line holds edits books those edits, never the original', async () => {
    const { calls } = renderHub(world());
    const open = await openLine();
    const text = within(open).getByRole('textbox', { name: 'Buchungstext' });
    await userEvent.clear(text);
    await userEvent.type(text, 'Büromaterial');
    const main = lineEl().querySelector('button.pl-main') as HTMLButtonElement;
    act(() => main.focus());
    fireEvent.keyDown(main, { key: 'f' });
    await waitFor(() => expect(calls.filter((c) => c.action === 'book_bank_line')).toHaveLength(1));
    expect(calls.find((c) => c.action === 'book_bank_line')?.input).toMatchObject({ text: 'Büromaterial' });
    expect(calls.some((c) => c.action === 'approve_drafted_action')).toBe(false);
  });

  it('6: a text rule that proposed the line is the one the star adapts (never a shadowed rule without text)', async () => {
    const TEXT_RULE = { ...OLD, id: 'std_t', label: 'Papeterie Rechnungen', matchText: 'rechnung', legs: [{ accountId: 'acc_50', taxCode: null, amount: { kind: 'rest' } }] };
    renderHub(
      world({
        list_bank_inbox: ok({ lines: [{ bankTxnId: 'btx_a1', ruleIds: ['std_t'], receiptCount: 1, standardId: 'std_t', proposal: { reasonCode: 'standard' } }] }),
        list_bank_standards: ok({ standards: [TEXT_RULE] }),
      }),
    );
    await openLine();
    await settle();
    expect(within(acts()).getByRole('button', { name: 'Regel anpassen' })).toBeInTheDocument();
  });

  it('D210 critic r1 MEDIUM-1: the open row star adapts THAT text rule (its id in the write), never a new rule without text', async () => {
    const TEXT_RULE = { ...OLD, id: 'std_t', label: 'Papeterie Rechnungen', matchText: 'rechnung', legs: [{ accountId: 'acc_50', taxCode: null, amount: { kind: 'rest' } }] };
    const { calls } = renderHub(
      world({
        list_bank_inbox: ok({ lines: [{ bankTxnId: 'btx_a1', ruleIds: ['std_t'], receiptCount: 1, standardId: 'std_t', proposal: { reasonCode: 'standard' } }] }),
        list_bank_standards: ok({ standards: [TEXT_RULE] }),
      }),
    );
    await openLine();
    await settle();
    rowStar('Regel anpassen');
    await waitFor(() => expect(writesOf(calls).filter((c) => c.action === 'set_bank_standard')).toHaveLength(1));
    const rule = writesOf(calls).find((c) => c.action === 'set_bank_standard');
    expect(rule?.input).toMatchObject({ standardId: 'std_t', matchText: 'rechnung' });
    expect(rule?.input).not.toHaveProperty('fromBankTxnId');
  });

  it('D210 critic r1 MEDIUM-2: with attention.auto_rule_confirm = always the open row star asks first; Abbrechen books nothing', async () => {
    const { calls } = renderHub(world({ settings_get: (input) => ok({ setting: { key: input.key, value: input.key === 'attention.auto_rule_confirm' ? 'always' : undefined } }) }));
    await openLine();
    await settle();
    rowStar();
    const ask = await screen.findByRole('group', { name: 'Freigeben und künftig automatisch' });
    expect(writesOf(calls)).toHaveLength(0);
    fireEvent.click(within(ask).getByRole('button', { name: 'Abbrechen' }));
    await settle();
    expect(writesOf(calls)).toHaveLength(0);
    rowStar();
    fireEvent.click(within(await screen.findByRole('group', { name: 'Freigeben und künftig automatisch' })).getByRole('button', { name: 'Freigeben und Regel speichern' }));
    await waitFor(() => expect(writesOf(calls).map((c) => c.action)).toEqual(['approve_drafted_action', 'set_bank_standard']));
  });

  it('D210 critic r1 LOW: while the line holds edits the doors leave the account list (no edit is dropped by a door)', async () => {
    renderHub(world());
    const open = await openLine();
    await settle();
    await userEvent.type(within(open).getByRole('textbox', { name: 'Buchungstext' }), ' neu');
    fireEvent.click(within(open).getByRole('combobox', { name: 'Konto' }));
    await screen.findAllByRole('option');
    expect(screen.queryByRole('option', { name: 'In Bank öffnen' })).toBeNull();
  });
});

describe('critic D208 round 2', () => {
  const pickAccount = async (open: HTMLElement, label: string) => {
    fireEvent.click(within(open).getByRole('combobox', { name: 'Konto' }));
    fireEvent.click(await screen.findByRole('option', { name: label }));
  };

  it('MEDIUM-A: the row star with an edited open line saves THOSE edits (booked and as the rule), never the agent\'s original', async () => {
    const { calls } = renderHub(world());
    const open = await openLine();
    await pickAccount(open, '6500 Verwaltungs- und Bürokosten');
    fireEvent.click(within(lineEl().querySelector('.pl-acts') as HTMLElement).getByRole('button', { name: 'Freigeben und als Regel speichern' }));
    await waitFor(() => expect(writesOf(calls).map((c) => c.action)).toEqual(['book_bank_line', 'set_bank_standard']));
    expect(writesOf(calls)[0]?.input).toMatchObject({ target: { kind: 'accounts', legs: [{ accountId: 'acc_50' }] } });
    expect(writesOf(calls)[1]?.input).toMatchObject({ fromBankTxnId: 'btx_a1', legs: [{ accountId: 'acc_50', amount: { kind: 'rest' } }] });
  });

  it('LOW-B: an edit after the confirm was asked drops it; nothing is committed with the old values', async () => {
    const { calls } = renderHub(world({ list_bank_inbox: inbox([], ['std_9']), list_bank_standards: ok({ standards: [OLD] }) }));
    const open = await openLine();
    rowStar();
    await screen.findByRole('group', { name: 'Freigeben und künftig automatisch' });
    await userEvent.type(within(open).getByRole('textbox', { name: 'Buchungstext' }), ' neu');
    expect(screen.queryByRole('group', { name: 'Freigeben und künftig automatisch' })).toBeNull();
    expect(writesOf(calls)).toHaveLength(0);
  });

  it('LOW-C: an adapted rule booked to another account is saved without its Durchlaufkonto', async () => {
    const RULE = {
      id: 'std_3',
      label: 'Papeterie',
      counterpartyLabel: 'Papeterie Sonnhalde GmbH',
      matchText: null,
      setAt: '2026-10-01T08:00:00.000Z',
      outcome: 'legs',
      note: null,
      viaAccountId: 'acc_via',
      followUpStandardId: null,
      legs: [{ accountId: 'acc_51', taxCode: null, amount: { kind: 'rest' } }],
    };
    const { calls } = renderHub(
      world({
        list_bank_inbox: ok({ lines: [{ bankTxnId: 'btx_a1', ruleIds: ['std_3'], receiptCount: 1, standardId: 'std_3', proposal: { reasonCode: 'standard' } }] }),
        list_bank_standards: ok({ standards: [RULE] }),
      }),
    );
    const open = await openLine();
    await settle();
    await pickAccount(open, '6500 Verwaltungs- und Bürokosten');
    rowStar('Regel anpassen');
    await waitFor(() => expect(writesOf(calls)).toHaveLength(2));
    expect(writesOf(calls)[1]?.input).toMatchObject({ standardId: 'std_3', label: 'Papeterie', legs: [{ accountId: 'acc_50' }] });
    expect(writesOf(calls)[1]?.input).not.toHaveProperty('viaAccountId');
  });
});

describe('critic D208 round 3', () => {
  it('LOW: with edits in an open line that offers no star, the row star is disabled and sends nothing', async () => {
    const via = { ...OUT_LINE, payload: { ...(OUT.payload as Record<string, unknown>), target: { kind: 'accounts', viaAccountId: 'acc_via', legs: [{ accountId: 'acc_51', amountMinor: -4870 }] } } };
    const { calls } = renderHub(world({ list_drafted_actions: ok({ actions: [via] }) }));
    const open = await openLine();
    expect(within(open).queryByRole('button', { name: 'Als Regel speichern' })).toBeNull();
    const text = within(open).getByRole('textbox', { name: 'Buchungstext' });
    await userEvent.type(text, ' neu');
    const star = within(lineEl().querySelector('.pl-acts') as HTMLElement).getByRole('button', { name: 'Freigeben und als Regel speichern' });
    expect(star).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(star);
    await settle();
    expect(writesOf(calls)).toHaveLength(0);
  });
});

describe('D210: the ways on live in the account list', () => {
  const IN = {
    ...OUT_LINE,
    lineFacts: { ...OUT_LINE.lineFacts, amountMinor: 1512 },
    payload: { ...(OUT.payload as Record<string, unknown>), target: { kind: 'accounts', legs: [{ accountId: 'acc_30', amountMinor: 1512 }] } },
  };
  const inWorld = (over: Canned = {}) =>
    world({ list_drafted_actions: ok({ actions: [IN] }), attention_list: ok(groupedOf([{ ...OUT_ROW, amountMinor: 1512 }], { grouping: 'by_kind' })), ...over });
  const TEMPLATE = ok({ templates: [{ system: 'stripe', processor: 'stripe', templateId: 'tpl_1', template: { clearingAccountId: 'acc_1095' } }] });
  const openAccounts = (open: HTMLElement) => fireEvent.click(within(open).getByRole('combobox', { name: 'Konto' }));

  it('money in with a turnover template: Als Umsatz buchen opens the line in Bank, and nothing is booked', async () => {
    const { calls } = renderHub(inWorld({ get_settlement_template: TEMPLATE }));
    const open = await openLine();
    await settle();
    openAccounts(open);
    fireEvent.click(await screen.findByRole('option', { name: 'Als Umsatz buchen' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/bank?line=btx_a1'));
    expect(writesOf(calls)).toHaveLength(0);
  });

  it('money in without a template: Als Umsatz buchen opens Umsatz on its rules', async () => {
    renderHub(inWorld({ get_settlement_template: ok({ templates: [] }) }));
    const open = await openLine();
    await settle();
    openAccounts(open);
    fireEvent.click(await screen.findByRole('option', { name: 'Als Umsatz buchen' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/umsatz?tab=regeln'));
  });

  it('money out offers no turnover door, only In Bank öffnen', async () => {
    renderHub(world({ get_settlement_template: TEMPLATE }));
    const open = await openLine();
    await settle();
    openAccounts(open);
    expect(await screen.findByRole('option', { name: 'In Bank öffnen' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Als Umsatz buchen' })).toBeNull();
  });

  it('a door entry never becomes the account: the account shown stays, and Freigeben approves the draft as it is', async () => {
    const { calls } = renderHub(world());
    const open = await openLine();
    await settle();
    const combo = within(open).getByRole('combobox', { name: 'Konto' });
    const before = combo.textContent;
    // Keyboard selection takes the same path as a click.
    act(() => combo.focus());
    fireEvent.keyDown(combo, { key: 'End' });
    fireEvent.keyDown(combo, { key: 'Enter' });
    await settle();
    // Back on Pendenzen only if the door did not fire; either way no booking and no changed account.
    if (screen.queryByTestId('where') === null) {
      expect(within(open).getByRole('combobox', { name: 'Konto' }).textContent).toBe(before);
      fireEvent.click(within(acts()).getByRole('button', { name: 'Freigeben' }));
      await waitFor(() => expect(writesOf(calls).map((c) => c.action)).toEqual(['approve_drafted_action']));
    } else {
      expect(screen.getByTestId('where')).toHaveTextContent('/bank?line=btx_a1');
      expect(writesOf(calls)).toHaveLength(0);
    }
  });
});
