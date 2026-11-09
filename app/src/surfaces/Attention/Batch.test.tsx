/**
 * D178 point 5, APPROVING SEVERAL BANK VORSCHLÄGE in Pendenzen, held:
 *
 *  - `tick` (the default): nothing is ticked on arrival, the button is disabled at 0, the header box ticks
 *    every row only on the person's act; only a row the engine marks `batchable` has a box (critic N4 M1), and
 *    a changed or self-drafted one never does; the bar shows for two or more batchable rows;
 *  - the run calls the EXISTING `approve_drafted_action` once per ticked row, strictly one after the other,
 *    each with exactly its row's declared input; each row shows its part while it runs;
 *  - a `vorschlag_stale` refusal in the middle neither stops nor undoes the others and is named in words; the
 *    stale row STAYS (the engine keeps it while its line is open) with one way on, the line in the bank;
 *  - the result names every approved row with a link to its entry, and every refused one with why;
 *    a refused row that is still pending (`cannot_self_approve`) stays ticked with its reason, focus on it;
 *  - ONE re-read at the end;
 *  - `single` renders no boxes; `all_with_confirm` names the count and the total before anything runs.
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
import { bankVorschlag, draftedBankLine, groupedOf, linesRow } from './testing';

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
const approveSelected = () => screen.getByRole('button', { name: /Ausgewählte genehmigen/ });

/** A list that answers `first` on the first read and `after` on every later one. */
function reads(first: Record<string, unknown>, after: Record<string, unknown>): Handler {
  let n = 0;
  return () => {
    n += 1;
    return ok(n === 1 ? first : after);
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('tick (the default): never pre-ticked, the person ticks', () => {
  it('nothing is ticked on arrival, the button is disabled at 0, the header box ticks every row only when ticked', async () => {
    renderHub({
      attention_list: ok(groupedOf([bankVorschlag('a1'), bankVorschlag('a2'), linesRow(5)])),
      list_drafted_actions: ok(DRAFTED),
    });
    await screen.findByText('5 Bankzeilen zu buchen');
    expect(boxes()).toHaveLength(2);
    expect(boxes().every((b) => !b.checked)).toBe(true);
    expect(approveSelected()).toBeDisabled();
    expect(approveSelected()).toHaveTextContent('Ausgewählte genehmigen (0)');
    // The N4 ruling: at 0 the commit is the quiet secondary and the page carries no accent at all.
    expect(approveSelected()).toHaveClass('btn--secondary');
    expect(approveSelected()).not.toHaveAttribute('data-money-commit');
    expect(document.querySelectorAll('.btn--accent')).toHaveLength(0);
    const all = screen.getByRole('checkbox', { name: 'Alle Vorschläge auswählen' });
    expect(all).not.toBeChecked();
    await userEvent.click(all);
    expect(boxes().every((b) => b.checked)).toBe(true);
    expect(approveSelected()).toHaveTextContent('Ausgewählte genehmigen (2)');
    // N4 H2: the commit is described by its (i): the engine's consequence of what it approves, then the
    // selection's count and its signed money ("2 Vorschläge, CHF -90.40").
    const described = document.getElementById(approveSelected().getAttribute('aria-describedby') ?? '')?.textContent ?? '';
    expect(described).toMatch(/2 Vorschläge, CHF\s?-90\.40$/);
    expect(described.length).toBeGreaterThan('2 Vorschläge, CHF -90.40'.length + 20);
    // B5 final judge: the batch has its own "Vorschläge n" sub-head (n = the tickable rows); the section head
    // keeps its area glyph and its count, and the select-all box never sits beside it.
    const bar = approveSelected().closest('.att-batch') as HTMLElement;
    expect(bar.querySelector('.att-batch-title')).toHaveTextContent(/Vorschläge\s*2/);
    expect(within(bar).getByRole('checkbox', { name: 'Alle Vorschläge auswählen' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Info' })).toBeInTheDocument();
    const sectionHead = bar.closest('section')?.querySelector('.att-section-head') as HTMLElement;
    expect(sectionHead.querySelector('h2')).toHaveTextContent(/Bank\s*\d/);
    expect(sectionHead.querySelector('.att-lead svg')).not.toBeNull();
    expect(sectionHead.querySelector('input[type="checkbox"]')).toBeNull();
    // Ticked, it is the page's ONE accent, naming the approval and the posting verb it replays.
    expect(approveSelected()).toHaveClass('btn--accent');
    expect(approveSelected()).toHaveAttribute('data-money-commit', 'approve_drafted_action book_bank_line');
    expect(document.querySelectorAll('.btn--accent')).toHaveLength(1);
    await userEvent.click(boxes()[0] as HTMLInputElement);
    expect(approveSelected()).toHaveTextContent('Ausgewählte genehmigen (1)');
    expect((all as HTMLInputElement).indeterminate).toBe(true);
  });

  it('a changed Vorschlag, the viewer\'s own and a non-bank one get no box; without the right there is no bar', async () => {
    const rows = [
      bankVorschlag('a1'),
      bankVorschlag('a2', { changedSinceProposal: true }),
      bankVorschlag('a3', { proposedBy: 'member:me' }),
      { ...bankVorschlag('a4'), queueId: 'agent_action', subtitleParams: { tool: 'post_entry' }, batchable: false },
      bankVorschlag('a5'),
    ];
    renderHub(
      { attention_list: ok(groupedOf(rows, { grouping: 'by_kind' })), list_drafted_actions: ok(DRAFTED) },
      { whoami: { actor: 'member:me', provisioned: true, isMember: true, memberId: 'm', userId: 'me', role: 'owner', capabilities: ['manage_agent_dial'] } },
    );
    const stale = await screen.findByText('Seit dem Vorschlag geändert');
    expect(boxes().map((b) => b.closest('.vorschlag-line')?.getAttribute('data-action-id'))).toEqual(['a1', 'a5']);
    expect(boxes()[0]?.getAttribute('aria-label')).toContain('auswählen');
    // The changed one says in words that it can no longer be approved, and offers no Genehmigen.
    const changed = stale.closest('.vorschlag-line') as HTMLElement;
    expect(changed.getAttribute('data-action-id')).toBe('a2');
    expect(within(changed).queryByRole('button', { name: 'Genehmigen' })).toBeNull();
  });

  it('a person without the right to approve sees no box and no bar (hidden, never refused)', async () => {
    renderHub({ attention_list: ok(groupedOf([bankVorschlag('a1'), bankVorschlag('a2')])), list_drafted_actions: ok(DRAFTED) }, { can: (c) => c !== 'manage_agent_dial' });
    await screen.findAllByText('Bankzeile buchen');
    expect(boxes()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /genehmigen \(/i })).toBeNull();
  });
});

describe('the run: the existing verb, one row after the other', () => {
  it('approves each ticked row with exactly its declared input, strictly in sequence, shows each row\'s part, and re-reads ONCE', async () => {
    const gates: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const { calls } = renderHub({
      attention_list: reads(groupedOf([bankVorschlag('a1'), bankVorschlag('a2'), bankVorschlag('a3')]), groupedOf([])),
      list_drafted_actions: ok(DRAFTED),
      approve_drafted_action: () =>
        new Promise<RestResponse>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          gates.push(() => {
            inFlight -= 1;
            resolve(ok({ actionId: 'x', status: 'executed' }));
          });
        }),
    });
    await screen.findAllByText('Bankzeile buchen');
    await userEvent.click(boxes()[0] as HTMLInputElement);
    await userEvent.click(boxes()[2] as HTMLInputElement);
    await userEvent.click(approveSelected());
    // The first runs, the second waits: one call at a time.
    await waitFor(() => expect(gates).toHaveLength(1));
    expect(screen.getByText('Wird genehmigt')).toBeInTheDocument();
    expect(screen.getByText('Wartet')).toBeInTheDocument();
    gates[0]?.();
    await waitFor(() => expect(gates).toHaveLength(2));
    gates[1]?.();
    expect(await screen.findByText('2 genehmigt.')).toBeInTheDocument();
    expect(maxInFlight).toBe(1);
    const approvals = calls.filter((c) => c.action === 'approve_drafted_action');
    expect(approvals.map((c) => c.input)).toEqual([
      { workspaceId: 'ws_test', actionId: 'a1' },
      { workspaceId: 'ws_test', actionId: 'a3' },
    ]);
    // One read before, ONE re-read after the whole batch.
    expect(calls.filter((c) => c.action === 'attention_list')).toHaveLength(2);
  });

  it('stale inside a batch: the middle row is refused and runs nothing, the others still run; the result names both, the stale row STAYS', async () => {
    // The engine keeps a stale line Vorschlag listed while its line is open: no Genehmigen, one way on.
    const staleA2 = bankVorschlag('a2', {
      stale: true,
      changedSinceProposal: true,
      batchable: false,
      kind: 'do',
      decisionOptions: [
        { id: 'check_in_bank', verb: null, labelKey: 'attention.act.checkInBank', role: 'link', input: {}, deepLink: { route: '/bank', params: { line: 'btx_a2' } } },
      ],
    });
    const { calls } = renderHub({
      attention_list: reads(groupedOf([bankVorschlag('a1'), bankVorschlag('a2'), bankVorschlag('a3')]), groupedOf([staleA2])),
      list_drafted_actions: (input) => ok(input.status === 'stale' ? { actions: [{ ...DRAFTED.actions[1], status: 'stale' }] } : DRAFTED),
      approve_drafted_action: (input) =>
        input.actionId === 'a2' ? refuse('vorschlag_stale', { actionId: 'a2' }) : ok({ actionId: input.actionId, status: 'executed', result: { entryId: `je_${String(input.actionId)}` } }),
    });
    await screen.findAllByText('Bankzeile buchen');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Alle Vorschläge auswählen' }));
    await userEvent.click(approveSelected());
    const result = await screen.findByText('2 genehmigt, 1 nicht genehmigt.');
    const banner = result.closest('[data-batch-result]') as HTMLElement;
    // Approved rows by name, each with its entry; the refused one with the one stale wording.
    expect(within(banner).getByText(/Kaffeebohnen August: genehmigt/)).toBeInTheDocument();
    const entryLinks = within(banner).getAllByRole('link', { name: 'Buchung öffnen' });
    expect(entryLinks.map((a) => a.getAttribute('href'))).toEqual(['/journal?entryId=je_a1', '/journal?entryId=je_a3']);
    expect(within(banner).getByText('Service Kaffeemaschine: Seit dem Vorschlag geändert, nicht mehr genehmigbar')).toBeInTheDocument();
    expect(calls.filter((c) => c.action === 'approve_drafted_action').map((c) => c.input.actionId)).toEqual(['a1', 'a2', 'a3']);
    // The stale row stays, with no box, no Genehmigen, the same words and one way on: the line in the bank.
    const line = document.querySelector('.vorschlag-line[data-action-id="a2"]') as HTMLElement;
    expect(line).not.toBeNull();
    expect(boxes()).toHaveLength(0);
    expect(within(line).queryByRole('button', { name: 'Genehmigen' })).toBeNull();
    const reason = within(line).getByText('Seit dem Vorschlag geändert');
    // L1 (N4): the row says the short words, the banner above said the whole sentence once.
    expect(within(line).queryByText(/nicht mehr genehmigbar/)).toBeNull();
    const wayOn = within(line).getByRole('button', { name: 'In der Bank prüfen' });
    // The reason comes BEFORE the way on (a phone and a screen reader meet the why first), inside the row.
    expect(reason.compareDocumentPosition(wayOn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reason.closest('.vorschlag-line-row')).not.toBeNull();
    // Its title is still the thing it booked, read from the stale draft.
    expect(within(line).getByText('Service Kaffeemaschine')).toBeInTheDocument();
  });

  it('a refused row that can still be approved stays ticked with its reason, and focus moves to its box', async () => {
    const after = groupedOf([bankVorschlag('a2')]);
    renderHub({
      attention_list: reads(groupedOf([bankVorschlag('a1'), bankVorschlag('a2')]), after),
      list_drafted_actions: ok(DRAFTED),
      approve_drafted_action: (input) => (input.actionId === 'a2' ? refuse('cannot_self_approve', { actionId: 'a2' }) : ok({ status: 'executed' })),
    });
    await screen.findAllByText('Bankzeile buchen');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Alle Vorschläge auswählen' }));
    await userEvent.click(approveSelected());
    await screen.findByText('1 genehmigt, 1 nicht genehmigt.');
    await waitFor(() => expect(boxes()).toHaveLength(1));
    expect(boxes()[0]).toBeChecked();
    const reasons = screen.getAllByText('Der eigene Vorschlag braucht eine zweite Person zur Freigabe.');
    // Named on the banner and on the row that stays.
    expect(reasons.some((r) => r.closest('.vorschlag-line') !== null)).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(boxes()[0]));
    expect(approveSelected()).toHaveTextContent('Ausgewählte genehmigen (1)');
  });
});

describe('one meaning per slot (the fresh-eyes judge, N4 M1 M3 H1)', () => {
  it('the counterparty leads the title, the meta is amount, booking account, date, and only the sign takes the danger ink', async () => {
    const row = bankVorschlag('a1', {
      subtitleParams: { tool: 'book_bank_line', date: '2026-10-20', target: '6500 Büromaterial', targetKind: 'rule', counterparty: 'Rösterei Seefeld AG' },
    });
    renderHub({ attention_list: ok(groupedOf([row, bankVorschlag('a2')])), list_drafted_actions: ok(DRAFTED) });
    const title = await screen.findByText('Rösterei Seefeld AG · Kaffeebohnen August');
    const line = title.closest('.vorschlag-line') as HTMLElement;
    expect(line.querySelector('.vorschlag-line-meta--hub')?.textContent?.replace(/\s+/g, ' ')).toBe('CHF -45.20 · 6500 Büromaterial · 20.10.2026');
    // The minus alone is the danger-ink span; the figure beside it is ink.
    expect(line.querySelector('.att-amount-sign')?.textContent).toBe('-');
    expect(line.querySelector('.att-row-amount')?.textContent).toBe('CHF -45.20');
    // The lead holds the box (two batchable rows show the batch), never a glyph.
    expect(line.querySelector('.att-lead svg')).toBeNull();
    expect(line.querySelector('.att-lead input[type="checkbox"]')).not.toBeNull();
  });
});

describe('one accent on the page, a confirm open or not', () => {
  it('with rows ticked, the Mahnlauf confirm takes the one accent and the batch commit goes quiet behind it, then gets it back', async () => {
    const dunning = {
      queueId: 'dunning_run',
      entityKind: 'dunning_run',
      entityId: 'run_1',
      titleKey: 'attention.item.dunningRun.title',
      titleParams: {},
      subtitleKey: 'attention.item.dunningRun.subtitleOne',
      subtitleParams: { count: 1, date: '2026-10-20' },
      since: '2026-10-20',
      urgency: 'open',
      deepLink: { route: '/dunning', params: { runId: 'run_1' } },
      decisionOptions: [
        { id: 'issue', verb: 'issue_dunning_run', labelKey: 'attention.act.issueDunningRun', role: 'primary', input: { runId: 'run_1', idempotencyKey: 'attention:issue:ws_test:run_1' }, humanConfirm: true, capability: 'dun' },
      ],
    };
    const run = {
      runId: 'run_1',
      runDate: '2026-10-20',
      status: 'proposed',
      items: [{ documentId: 'RE-1', debtorId: 'c1', level: 1, currency: 'CHF', overdueMinor: 48000, feeMinor: 2000, demandedFeeMinor: 0, feeBooked: false, daysOverdue: 12 }],
      debtors: [{ debtorId: 'c1', itemCount: 1, maxLevel: 1, totalsByCurrency: { CHF: 48000 } }],
    };
    const { calls } = renderHub({
      attention_list: ok(groupedOf([bankVorschlag('a1'), bankVorschlag('a2'), dunning])),
      list_drafted_actions: ok(DRAFTED),
      get_dunning_run: ok(run),
    });
    await screen.findByText('Mahnlauf bereit zum Ausstellen');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Alle Vorschläge auswählen' }));
    expect(approveSelected()).toHaveClass('btn--accent');
    await userEvent.click(screen.getByRole('button', { name: 'Mahnlauf ausstellen' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Mahnlauf ausstellen?' });
    await within(dialog).findByText(/Gebühren CHF\s?20\.00/);
    const commit = within(dialog).getByRole('button', { name: 'Mahnlauf ausstellen' });
    expect([...document.querySelectorAll('.btn--accent')]).toEqual([commit]);
    expect(approveSelected()).toHaveClass('btn--secondary');
    expect(approveSelected()).not.toHaveAttribute('data-money-commit');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    // Nothing was written; the ticks stay, and the batch commit holds the one accent again.
    expect(calls.filter((c) => c.action === 'issue_dunning_run' || c.action === 'approve_drafted_action')).toHaveLength(0);
    expect(boxes().every((b) => b.checked)).toBe(true);
    expect([...document.querySelectorAll('.btn--accent')]).toEqual([approveSelected()]);
  });
});

describe('the other two modes (the workspace setting)', () => {
  it('single: no boxes and no bar; every line keeps its own Genehmigen', async () => {
    renderHub({ attention_list: ok(groupedOf([bankVorschlag('a1'), bankVorschlag('a2')], { approvalBatchMode: 'single' })), list_drafted_actions: ok(DRAFTED) });
    await screen.findAllByText('Bankzeile buchen');
    expect(boxes()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /genehmigen \(/i })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Genehmigen' })).toHaveLength(2);
  });

  it('all_with_confirm: one button names the count, the confirm names the money out, and nothing runs before the yes', async () => {
    const { calls } = renderHub({
      attention_list: reads(groupedOf([bankVorschlag('a1'), bankVorschlag('a2')], { approvalBatchMode: 'all_with_confirm' }), groupedOf([])),
      list_drafted_actions: ok(DRAFTED),
      approve_drafted_action: ok({ status: 'executed' }),
    });
    await screen.findAllByText('Bankzeile buchen');
    expect(boxes()).toHaveLength(0);
    await waitFor(() => expect(calls.some((c) => c.action === 'list_drafted_actions')).toBe(true));
    // The opener only opens the confirm: quiet. The accent sits on the commit inside the confirm.
    const opener = screen.getByRole('button', { name: 'Alle genehmigen (2)' });
    expect(opener).toHaveClass('btn--secondary');
    expect(document.querySelectorAll('.btn--accent')).toHaveLength(0);
    await userEvent.click(opener);
    const dialog = await screen.findByRole('alertdialog', { name: '2 Vorschläge genehmigen?' });
    const yes = within(dialog).getByRole('button', { name: '2 genehmigen' });
    expect(yes).toHaveClass('btn--accent');
    expect(yes).toHaveAttribute('data-money-commit', 'approve_drafted_action book_bank_line');
    expect(document.querySelectorAll('.btn--accent')).toHaveLength(1);
    // Two lines of CHF -45.20 each (the line's own signed amount): money out, per currency.
    expect(within(dialog).getByText(/Ausgang CHF\s?90\.40/)).toBeInTheDocument();
    expect(calls.filter((c) => c.action === 'approve_drafted_action')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: '2 genehmigen' }));
    expect(await screen.findByText('2 genehmigt.')).toBeInTheDocument();
    expect(calls.filter((c) => c.action === 'approve_drafted_action').map((c) => c.input.actionId)).toEqual(['a1', 'a2']);
  });
});

describe('accessibility', () => {
  it('the bar, the boxes and the lines pass axe', async () => {
    const { container } = renderHub({ attention_list: ok(groupedOf([bankVorschlag('a1'), bankVorschlag('a2'), linesRow(5)])), list_drafted_actions: ok(DRAFTED) });
    await screen.findByText('5 Bankzeilen zu buchen');
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});
