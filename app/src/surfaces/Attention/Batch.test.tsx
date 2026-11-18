/**
 * D201 point 4, SEVERAL VORSCHLÄGE AT ONCE in Pendenzen, held:
 *
 *  - nothing is ticked on arrival and no bar shows; a box sits on every Vorschlag the person may decide (never
 *    their own); the head box ticks every visible one only on the person's act;
 *  - the sticky bar offers "Freigeben (n)" for the ticked rows the batch may approve (the engine's
 *    `batchable`, unchanged) and "Ablehnen (n)" for every ticked row; each is ONE call of the batch verb
 *    (`approve_drafted_actions`, `reject_drafted_actions`), never a loop of single calls;
 *  - per-id outcomes drive the page: what went through leaves, what failed stays ticked with its cause in
 *    its row; a whole-call refusal runs nothing and keeps the ticks;
 *  - rejecting asks nothing (D204): no reason field, no reason sent;
 *  - the one accent: Freigeben wears it only while a ticked row posts, and goes quiet behind another
 *    commit's confirm;
 *  - `single`: no Freigeben in the bar (each line keeps its own), Ablehnen stays; `all_with_confirm`: the bar's
 *    Freigeben opens the confirm with the count and the money, and nothing runs before the yes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { Attention } from './index';
import { parseBatchAnswer } from './Batch';
import { bankVorschlag, draftedBankLine, groupedOf, linesRow } from './testing';

/** D208: select-all sits in each section's heading; this ticks every section's box. */
async function tickAllSections() {
  for (const box of screen.getAllByRole('checkbox', { name: /^Alle (angezeigten )?in .* auswählen$/ })) await userEvent.click(box);
}


type Call = { action: string; input: Record<string, unknown> };
type Handler = (input: Record<string, unknown>) => RestResponse | Promise<RestResponse>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const refuse = (error: string, extra: Record<string, unknown> = {}): RestResponse => ({ status: 422, body: { ok: false, error, ...extra } });

const DRAFTED = { actions: [draftedBankLine('a1', 'Kaffeebohnen August', 12990), draftedBankLine('a2', 'Service Kaffeemaschine', 24800), draftedBankLine('a3', 'Porto Pakete', 1890)] };

function renderHub(handlers: Record<string, RestResponse | Handler>, caps: Partial<Capabilities> = {}) {
  const calls: Call[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input: (input ?? {}) as Record<string, unknown> });
    const entry = handlers[action];
    if (entry === undefined) return ok();
    return typeof entry === 'function' ? await entry((input ?? {}) as Record<string, unknown>) : entry;
  };
  const capabilities: Capabilities = { whoami: null, can: () => true, refresh: () => undefined, ...caps };
  const view = render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesContext.Provider value={capabilities}>
            <MemoryRouter initialEntries={['/attention']}>
              <Attention />
            </MemoryRouter>
          </CapabilitiesContext.Provider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
  return { ...view, calls };
}

const boxes = () => [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-batch-row]')];
const dock = () => document.querySelector('.att-dock') as HTMLElement | null;
const approveSelected = () => within(dock() as HTMLElement).getByRole('button', { name: /^Freigeben \(/ });
const rejectSelected = () => within(dock() as HTMLElement).getByRole('button', { name: /^Ablehnen \(/ });
const selectAll = () => screen.getAllByRole('checkbox', { name: /^Alle (angezeigten )?in .* auswählen$/ })[0] as HTMLElement;

/** A list that answers `first` on the first read and `after` on every later one. */
function reads(first: Record<string, unknown>, after: Record<string, unknown>): Handler {
  let n = 0;
  return () => {
    n += 1;
    return ok(n === 1 ? first : after);
  };
}

/** The batch verb's answer: one item per id, in order. */
const answer = (items: { actionId: string; ok: boolean; error?: string }[]) =>
  ok({
    items: items.map((i, index) => (i.ok ? { index, actionId: i.actionId, ok: true, result: { ok: true } } : { index, actionId: i.actionId, ok: false, refusal: { ok: false, error: i.error ?? 'refused' } })),
    count: items.length,
    okCount: items.filter((i) => i.ok).length,
    refusedCount: items.filter((i) => !i.ok).length,
  });

beforeEach(() => {
  window.localStorage.clear();
});

describe('the selection: never pre-ticked, the person ticks', () => {
  it('nothing is ticked on arrival and no bar shows; the head box ticks every visible Vorschlag', async () => {
    renderHub({ attention_list: ok(groupedOf([bankVorschlag('a1'), bankVorschlag('a2'), linesRow(5)])), list_drafted_actions: ok(DRAFTED) });
    await screen.findByText('5 Bankzeilen zu buchen');
    expect(boxes()).toHaveLength(2);
    expect(boxes().every((b) => !b.checked)).toBe(true);
    expect(dock()).toBeNull();
    expect(document.querySelectorAll('.btn--accent')).toHaveLength(0);
    await tickAllSections();
    expect(boxes().every((b) => b.checked)).toBe(true);
    expect(dock()?.querySelector('.vsel-count')).toHaveTextContent('2 ausgewählt');
    expect(approveSelected()).toHaveTextContent('Freigeben (2)');
    expect(rejectSelected()).toHaveTextContent('Ablehnen (2)');
    // The page's ONE accent, naming the approval and the posting verb it replays.
    expect(approveSelected()).toHaveClass('btn--accent');
    expect(approveSelected()).toHaveAttribute('data-money-commit', 'approve_drafted_action book_bank_line');
    expect(document.querySelectorAll('.btn--accent')).toHaveLength(1);
    await userEvent.click(boxes()[0] as HTMLInputElement);
    expect(approveSelected()).toHaveTextContent('Freigeben (1)');
    expect((selectAll() as HTMLInputElement).indeterminate).toBe(true);
  });

  it('the viewer\'s own Vorschlag gets no box; a non-bank one is only rejected in a batch; a changed one is never approved in one', async () => {
    const rows = [
      bankVorschlag('a1'),
      bankVorschlag('a2', { changedSinceProposal: true }),
      bankVorschlag('a3', { proposedBy: 'member:me' }),
      { ...bankVorschlag('a4'), queueId: 'agent_action', subtitleParams: { tool: 'post_entry' }, batchable: false },
    ];
    renderHub(
      { attention_list: ok(groupedOf(rows)), list_drafted_actions: ok(DRAFTED) },
      { whoami: { actor: 'member:me', provisioned: true, isMember: true, memberId: 'm', userId: 'me', role: 'owner', capabilities: ['manage_agent_dial'] } },
    );
    await screen.findByText('Geändert');
    expect(boxes().map((b) => b.closest('.pl')?.getAttribute('data-action-id')).sort()).toEqual(['a1', 'a2', 'a4']);
    await tickAllSections();
    // Freigeben counts only the unchanged bank decision; Ablehnen every ticked row.
    expect(approveSelected()).toHaveTextContent('Freigeben (1)');
    expect(rejectSelected()).toHaveTextContent('Ablehnen (3)');
  });

  it('a person without the right to decide sees no box and no bar (hidden, never refused)', async () => {
    renderHub({ attention_list: ok(groupedOf([bankVorschlag('a1'), bankVorschlag('a2')])), list_drafted_actions: ok(DRAFTED) }, { can: (c) => c !== 'manage_agent_dial' });
    await screen.findAllByText('Bankzeile buchen');
    expect(boxes()).toHaveLength(0);
    expect(dock()).toBeNull();
  });
});

describe('the run: ONE call of the batch verb, outcomes per id', () => {
  it('Freigeben sends approve_drafted_actions once with every ticked id; the approved rows leave, the failed one stays ticked with its cause', async () => {
    const { calls } = renderHub({
      attention_list: reads(groupedOf([bankVorschlag('a1'), bankVorschlag('a2'), bankVorschlag('a3')]), groupedOf([bankVorschlag('a2')])),
      list_drafted_actions: ok(DRAFTED),
      approve_drafted_actions: answer([
        { actionId: 'a1', ok: true },
        { actionId: 'a2', ok: false, error: 'period_locked' },
        { actionId: 'a3', ok: true },
      ]),
    });
    await screen.findAllByText('Bankzeile buchen');
    await tickAllSections();
    await userEvent.click(approveSelected());
    expect(await screen.findByText('2 freigegeben, 1 nicht freigegeben.')).toBeInTheDocument();
    const batch = calls.filter((c) => c.action === 'approve_drafted_actions');
    expect(batch).toHaveLength(1);
    expect(batch[0]?.input).toEqual({ workspaceId: 'ws_test', ids: ['a1', 'a2', 'a3'] });
    // Never a loop of single calls.
    expect(calls.filter((c) => c.action === 'approve_drafted_action')).toHaveLength(0);
    await waitFor(() => expect(boxes()).toHaveLength(1));
    const left = boxes()[0] as HTMLInputElement;
    expect(left.closest('.pl')?.getAttribute('data-action-id')).toBe('a2');
    expect(left).toBeChecked();
    expect(left.closest('.pl')).toHaveTextContent('Die Periode ist gesperrt');
    expect(approveSelected()).toHaveTextContent('Freigeben (1)');
  });

  it('Ablehnen sends reject_drafted_actions once with every ticked id and NO reason; nothing asks for one', async () => {
    const { calls } = renderHub({
      attention_list: reads(groupedOf([bankVorschlag('a1'), bankVorschlag('a2')]), groupedOf([])),
      list_drafted_actions: ok(DRAFTED),
      reject_drafted_actions: answer([
        { actionId: 'a1', ok: true },
        { actionId: 'a2', ok: true },
      ]),
    });
    await screen.findAllByText('Bankzeile buchen');
    await tickAllSections();
    await userEvent.click(rejectSelected());
    expect(await screen.findByText('2 abgelehnt. Gebucht wurde nichts.')).toBeInTheDocument();
    expect(document.querySelector('textarea')).toBeNull();
    const batch = calls.filter((c) => c.action === 'reject_drafted_actions');
    expect(batch).toHaveLength(1);
    expect(batch[0]?.input).toEqual({ workspaceId: 'ws_test', ids: ['a1', 'a2'] });
    expect(calls.filter((c) => c.action === 'reject_drafted_action')).toHaveLength(0);
    await waitFor(() => expect(dock()).toBeNull());
  });

  it('a whole-call refusal runs nothing, says why, and keeps the ticks', async () => {
    renderHub({
      attention_list: ok(groupedOf([bankVorschlag('a1'), bankVorschlag('a2')])),
      list_drafted_actions: ok(DRAFTED),
      approve_drafted_actions: refuse('permission_denied'),
    });
    await screen.findAllByText('Bankzeile buchen');
    await tickAllSections();
    await userEvent.click(approveSelected());
    expect(await screen.findByText('Dafür fehlt dir die Berechtigung.')).toBeInTheDocument();
    expect(boxes().every((b) => b.checked)).toBe(true);
  });

  it('a stale id is said in the one short wording in its row', async () => {
    renderHub({
      attention_list: ok(groupedOf([bankVorschlag('a1'), bankVorschlag('a2')])),
      list_drafted_actions: ok(DRAFTED),
      approve_drafted_actions: answer([
        { actionId: 'a1', ok: false, error: 'vorschlag_stale' },
        { actionId: 'a2', ok: false, error: 'already_resolved' },
      ]),
    });
    await screen.findAllByText('Bankzeile buchen');
    await tickAllSections();
    await userEvent.click(approveSelected());
    expect(await screen.findByText('0 freigegeben, 2 nicht freigegeben.')).toBeInTheDocument();
    const line = (id: string) => document.querySelector(`.pl[data-action-id="${id}"]`) as HTMLElement;
    expect(line('a1')).toHaveTextContent('Geändert');
    expect(line('a2')).toHaveTextContent('Dieser Vorschlag ist schon entschieden.');
  });

  it('parseBatchAnswer: an id the answer does not mention is not done', () => {
    expect(parseBatchAnswer({ items: [{ index: 0, actionId: 'a1', ok: true }] }, ['a1', 'a2'])).toEqual({ done: ['a1'], failed: [{ id: 'a2', refusal: { ok: false, error: 'refused' } }] });
    expect(parseBatchAnswer({ items: [{ index: 1, ok: false, refusal: { ok: false, error: 'not_found' } }] }, ['a1', 'a2']).failed.map((f) => [f.id, f.refusal.error])).toEqual([
      ['a2', 'not_found'],
      ['a1', 'refused'],
    ]);
  });
});

describe('one accent on the page', () => {
  it('ticking only a row that books nothing leaves Freigeben quiet with no booking claim', async () => {
    renderHub({
      attention_list: ok(groupedOf([bankVorschlag('a1', { posts: false, subtitleParams: { tool: 'ignore_bank_line', date: '2026-10-20', targetKind: 'ignore' } }), bankVorschlag('a2')])),
      list_drafted_actions: ok(DRAFTED),
    });
    await screen.findAllByText(/Bankzeile/);
    await userEvent.click(boxes()[0] as HTMLInputElement);
    expect(approveSelected()).toHaveClass('btn--secondary');
    expect(approveSelected()).not.toHaveAttribute('data-money-commit');
    await userEvent.click(boxes()[1] as HTMLInputElement);
    expect(approveSelected()).toHaveClass('btn--accent');
  });
});

describe('the other two modes (the workspace setting)', () => {
  it('single: the bar offers no Freigeben, each line keeps its own; Ablehnen for many stays', async () => {
    renderHub({ attention_list: ok(groupedOf([bankVorschlag('a1'), bankVorschlag('a2')], { approvalBatchMode: 'single' })), list_drafted_actions: ok(DRAFTED) });
    await screen.findAllByText('Bankzeile buchen');
    await tickAllSections();
    expect(within(dock() as HTMLElement).queryByRole('button', { name: /^Freigeben \(/ })).toBeNull();
    expect(rejectSelected()).toHaveTextContent('Ablehnen (2)');
    expect(screen.getAllByRole('button', { name: 'Freigeben' }).length).toBeGreaterThanOrEqual(2);
  });

  it('all_with_confirm: Freigeben opens the confirm with the count and the money out; nothing runs before the yes', async () => {
    const { calls } = renderHub({
      attention_list: reads(groupedOf([bankVorschlag('a1'), bankVorschlag('a2')], { approvalBatchMode: 'all_with_confirm' }), groupedOf([])),
      list_drafted_actions: ok(DRAFTED),
      approve_drafted_actions: answer([
        { actionId: 'a1', ok: true },
        { actionId: 'a2', ok: true },
      ]),
    });
    await screen.findAllByText('Bankzeile buchen');
    await tickAllSections();
    await userEvent.click(approveSelected());
    const dialog = await screen.findByRole('alertdialog', { name: '2 Vorschläge freigeben?' });
    const yes = within(dialog).getByRole('button', { name: '2 freigeben' });
    expect(yes).toHaveClass('btn--accent');
    expect(document.querySelectorAll('.btn--accent')).toHaveLength(1);
    expect(within(dialog).getByText(/Ausgang CHF\s?90\.40/)).toBeInTheDocument();
    expect(calls.filter((c) => c.action === 'approve_drafted_actions')).toHaveLength(0);
    await userEvent.click(yes);
    expect(await screen.findByText('2 freigegeben.')).toBeInTheDocument();
    expect(calls.filter((c) => c.action === 'approve_drafted_actions').map((c) => c.input.ids)).toEqual([['a1', 'a2']]);
  });
});

describe('20 and more rows, and accessibility', () => {
  it('twenty-four Vorschläge: one list, one head box ticks them all, one call carries every id', async () => {
    const many = Array.from({ length: 24 }, (_, i) => bankVorschlag(`v${i + 1}`));
    const { calls } = renderHub({
      attention_list: reads(groupedOf(many), groupedOf([])),
      list_drafted_actions: ok({ actions: [] }),
      approve_drafted_actions: (input) => answer((input.ids as string[]).map((actionId) => ({ actionId, ok: true }))),
    });
    await waitFor(() => expect(boxes()).toHaveLength(24));
    await tickAllSections();
    expect(approveSelected()).toHaveTextContent('Freigeben (24)');
    await userEvent.click(approveSelected());
    expect(await screen.findByText('24 freigegeben.')).toBeInTheDocument();
    expect((calls.find((c) => c.action === 'approve_drafted_actions')?.input.ids as string[]).length).toBe(24);
  });

  it('the bar, the boxes and the lines pass axe', async () => {
    const { container } = renderHub({ attention_list: ok(groupedOf([bankVorschlag('a1'), bankVorschlag('a2'), linesRow(5)])), list_drafted_actions: ok(DRAFTED) });
    await screen.findByText('5 Bankzeilen zu buchen');
    await tickAllSections();
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});
