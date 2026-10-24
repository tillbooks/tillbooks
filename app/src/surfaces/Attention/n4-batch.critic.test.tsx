/**
 * Critic N4 (D178 points 5 and 11), non-author probes on the STUDIO side of the Pendenzen batch.
 *
 * Every row here is the shape the engine sends (see `test/critic/n4-batch-scope.test.mjs` for the engine
 * half). The critic's "FINDING" probes pinned each defect as observed at e0acfd5d; round 2 FLIPPED them to
 * the corrected behaviour (named "FIXED" now), so each one fails again if its defect comes back. Tests named
 * "SOUND" hold a property the critic checked and found to hold.
 *
 * Synthetic by construction: invented names, amounts and ids.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

/** A list that answers `first` on the first read and `after` on every later one. */
function reads(first: Record<string, unknown>, after: Record<string, unknown>): Handler {
  let n = 0;
  return () => {
    n += 1;
    return ok(n === 1 ? first : after);
  };
}

/** A drafted bank Vorschlag of another verb, as list_drafted_actions answers it. */
function drafted(actionId: string, actionTool: string, payload: Record<string, unknown>, dialCapability = 'pay'): Record<string, unknown> {
  return { actionId, actor: 'agent', dialCapability, actionTool, payload, status: 'pending', createdAt: '2026-10-21T07:00:00.000Z' };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('FIXED M1: the batch reaches only the decisions on a bank line (the engine flag)', () => {
  it('tick: the IBAN redirect and the QR auto-apply switch get no box and keep their own Genehmigen; select all + approve runs the two bookings only', async () => {
    // The engine marks only bank-line decisions `batchable` (n4-batch-scope.test.mjs, SCOPE); the Studio reads that flag.
    const rows = [
      bankVorschlag('a1'),
      bankVorschlag('a_iban', { subtitleParams: { tool: 'set_creditor_bank_profile' }, consequenceKey: 'agent.consequence.pay', batchable: false, amountMinor: undefined, currency: undefined }),
      bankVorschlag('a_auto', { subtitleParams: { tool: 'set_qr_auto_apply' }, consequenceKey: 'agent.consequence.pay', batchable: false, amountMinor: undefined, currency: undefined }),
      bankVorschlag('a2'),
    ];
    const { calls } = renderHub({
      attention_list: reads(groupedOf(rows), groupedOf([])),
      list_drafted_actions: ok({
        actions: [
          draftedBankLine('a1', 'Kaffeebohnen', 12990),
          drafted('a_iban', 'set_creditor_bank_profile', { vendorId: 'ct_9', iban: 'CH5604835012345678009', idempotencyKey: 'k_iban' }),
          drafted('a_auto', 'set_qr_auto_apply', { autoApply: true, idempotencyKey: 'k_auto' }),
          draftedBankLine('a2', 'Porto', 1890),
        ],
      }),
      approve_drafted_action: ok({ status: 'executed' }),
    });
    await waitFor(() => expect(boxes()).toHaveLength(2));
    // The two that are not line decisions are lines with their own Genehmigen, never a checkbox.
    for (const id of ['a_iban', 'a_auto']) {
      const line = document.querySelector(`.vorschlag-line[data-action-id="${id}"]`) as HTMLElement;
      expect(line.querySelector('input[type="checkbox"]')).toBeNull();
      expect(within(line).getByRole('button', { name: 'Genehmigen' })).toBeInTheDocument();
    }
    await userEvent.click(screen.getByRole('checkbox', { name: 'Alle Vorschläge auswählen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ausgewählte genehmigen (2)' }));
    expect(await screen.findByText('2 genehmigt.')).toBeInTheDocument();
    expect(calls.filter((c) => c.action === 'approve_drafted_action').map((c) => c.input.actionId)).toEqual(['a1', 'a2']);
  });

  it('all_with_confirm: "Alle genehmigen" counts and runs only the batchable rows', async () => {
    const rows = [
      bankVorschlag('a1'),
      bankVorschlag('a_iban', { subtitleParams: { tool: 'set_creditor_bank_profile' }, batchable: false, amountMinor: undefined, currency: undefined }),
      bankVorschlag('a2'),
    ];
    const { calls } = renderHub({
      attention_list: reads(groupedOf(rows, { approvalBatchMode: 'all_with_confirm' }), groupedOf([])),
      list_drafted_actions: ok({ actions: [draftedBankLine('a1', 'Eins', 100), draftedBankLine('a2', 'Zwei', 200)] }),
      approve_drafted_action: ok({ status: 'executed' }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Alle genehmigen (2)' }));
    const dialog = await screen.findByRole('alertdialog', { name: '2 Vorschläge genehmigen?' });
    await userEvent.click(within(dialog).getByRole('button', { name: '2 genehmigen' }));
    await screen.findByText('2 genehmigt.');
    expect(calls.filter((c) => c.action === 'approve_drafted_action').map((c) => c.input.actionId)).toEqual(['a1', 'a2']);
  });
});

describe('FIXED M2: the confirm names the money per currency, in and out apart, from the line itself', () => {
  it('a CHF line and a EUR line confirm as two currencies, never one sum; nothing is read from the payload', async () => {
    // The engine sends the bank line's own signed amount and currency on the row (n4-batch-scope, TOTAL).
    const { calls } = renderHub({
      attention_list: reads(
        groupedOf([bankVorschlag('a_chf', { amountMinor: -10000, currency: 'CHF' }), bankVorschlag('a_eur', { amountMinor: -50000, currency: 'EUR' })], {
          approvalBatchMode: 'all_with_confirm',
        }),
        groupedOf([]),
      ),
      // The payload legs say something else on purpose: the confirm must not read them.
      list_drafted_actions: ok({ actions: [draftedBankLine('a_chf', 'Büromaterial', 99), draftedBankLine('a_eur', 'Messe Stand Köln', 99)] }),
      approve_drafted_action: ok({ status: 'executed' }),
    });
    await waitFor(() => expect(calls.some((c) => c.action === 'list_drafted_actions')).toBe(true));
    await userEvent.click(await screen.findByRole('button', { name: 'Alle genehmigen (2)' }));
    const dialog = await screen.findByRole('alertdialog', { name: '2 Vorschläge genehmigen?' });
    const total = dialog.querySelector('.att-batch-confirm-total')?.textContent ?? '';
    expect(total).toMatch(/Ausgang CHF\s?100\.00/);
    expect(total).toMatch(/Ausgang EUR\s?500\.00/);
    expect(within(dialog).queryByText(/Zusammen/)).toBeNull();
    expect(total).not.toMatch(/600/);
  });

  it('a credit and a debit stay apart: in CHF 100.00 and out CHF 300.00, never "CHF 400.00"', async () => {
    renderHub({
      attention_list: ok(
        groupedOf([bankVorschlag('a_in', { amountMinor: 10000 }), bankVorschlag('a_out', { amountMinor: -30000 })], { approvalBatchMode: 'all_with_confirm' }),
      ),
      list_drafted_actions: ok({ actions: [draftedBankLine('a_in', 'Kundenzahlung', 10000), draftedBankLine('a_out', 'Miete', -30000)] }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Alle genehmigen (2)' }));
    const dialog = await screen.findByRole('alertdialog');
    const total = dialog.querySelector('.att-batch-confirm-total')?.textContent ?? '';
    expect(total).toMatch(/Eingang CHF\s?100\.00/);
    expect(total).toMatch(/Ausgang CHF\s?300\.00/);
    expect(total).not.toMatch(/400/);
  });

  it('a row without an amount is counted apart, never given a currency', async () => {
    renderHub({
      attention_list: ok(groupedOf([bankVorschlag('a1'), bankVorschlag('a2', { amountMinor: undefined, currency: undefined })], { approvalBatchMode: 'all_with_confirm' })),
      list_drafted_actions: ok({ actions: [] }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Alle genehmigen (2)' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Dazu 1 ohne Betrag.')).toBeInTheDocument();
  });

  it('every bank Vorschlag row shows the line amount, what it books onto and the date, in that order', async () => {
    renderHub({
      attention_list: ok(groupedOf([bankVorschlag('a1', { amountMinor: -4520, currency: 'CHF' })])),
      list_drafted_actions: ok({ actions: [draftedBankLine('a1', 'Büromaterial', 4520)] }),
    });
    await waitFor(() => expect(document.querySelector('.vorschlag-line-meta--hub')).not.toBeNull());
    const meta = (document.querySelector('.vorschlag-line-meta--hub') as HTMLElement).textContent ?? '';
    expect(meta.replace(/\s+/g, ' ')).toMatch(/^CHF -45\.20 · 6500 Büromaterial · 20\.10\.2026$/);
  });
});

describe('FIXED L1: "Alle" says what it covers', () => {
  it('a bank section with more rows behind its cursor offers "Angezeigte genehmigen (2)", never "Alle genehmigen"', async () => {
    const { calls } = renderHub({
      attention_list: reads(
        groupedOf([bankVorschlag('a1'), bankVorschlag('a2')], { approvalBatchMode: 'all_with_confirm', more: { bank: { count: 30, nextCursor: '2' } } }),
        groupedOf([]),
      ),
      list_drafted_actions: ok({ actions: [draftedBankLine('a1', 'Eins', 100), draftedBankLine('a2', 'Zwei', 200)] }),
      approve_drafted_action: ok({ status: 'executed' }),
    });
    await screen.findByRole('button', { name: 'Angezeigte genehmigen (2)' });
    expect(document.querySelector('[data-section="bank"]')?.getAttribute('data-count')).toBe('32');
    expect(screen.queryByRole('button', { name: /^Alle genehmigen/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Angezeigte genehmigen (2)' }));
    const dialog = await screen.findByRole('alertdialog', { name: '2 Vorschläge genehmigen?' });
    await userEvent.click(within(dialog).getByRole('button', { name: '2 genehmigen' }));
    await screen.findByText('2 genehmigt.');
    expect(calls.filter((c) => c.action === 'approve_drafted_action')).toHaveLength(2);
  });

  it('tick mode with more behind the cursor: the header box is "Alle angezeigten Vorschläge auswählen"', async () => {
    renderHub({
      attention_list: ok(groupedOf([bankVorschlag('a1'), bankVorschlag('a2')], { more: { bank: { count: 30, nextCursor: '2' } } })),
      list_drafted_actions: ok({ actions: [] }),
    });
    expect(await screen.findByRole('checkbox', { name: 'Alle angezeigten Vorschläge auswählen' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Alle Vorschläge auswählen' })).toBeNull();
  });
});

describe('FIXED L2: a remainder row of a Vorschläge queue renders as a remainder row', () => {
  it('"3 weitere in Bank-Vorschläge" is on screen as its own row, not drawn as a Vorschlag line', async () => {
    const remainder = {
      queueId: 'agent_action_bank',
      entityKind: 'attention_remainder',
      entityId: 'agent_action_bank:remainder',
      titleKey: 'attention.remainder.title',
      titleParams: { count: 3, queueId: 'agent_action_bank' },
      count: 3,
      since: '',
      urgency: 'open',
      deepLink: { route: '/agent', params: {} },
      decisionOptions: [{ id: 'open', verb: null, labelKey: 'attention.remainder.open', role: 'link', input: {}, deepLink: { route: '/agent', params: {} } }],
      reasonCode: null,
      reasonKey: null,
      consequenceKey: null,
      consequence: null,
    };
    renderHub({ attention_list: ok(groupedOf([bankVorschlag('a1'), remainder])), list_drafted_actions: ok({ actions: [draftedBankLine('a1', 'Eins', 100)] }) });
    expect(await screen.findByText('3 weitere in Bank-Vorschläge')).toBeInTheDocument();
    const lines = [...document.querySelectorAll('.vorschlag-line')];
    expect(lines.map((l) => l.getAttribute('data-action-id'))).toEqual(['a1']);
    expect(document.querySelector('.att-row[data-row-count="3"]')).not.toBeNull();
  });
});

describe('SOUND: the batch only ever runs rows the person ticked', () => {
  it('a re-read that brings a NEW bank Vorschlag after "select all" leaves it unticked and out of the run', async () => {
    const { calls } = renderHub({
      attention_list: reads(groupedOf([bankVorschlag('a1'), bankVorschlag('a2')]), groupedOf([bankVorschlag('a1'), bankVorschlag('a2'), bankVorschlag('a_new')])),
      list_drafted_actions: ok({ actions: [draftedBankLine('a1', 'Eins', 100), draftedBankLine('a2', 'Zwei', 200), draftedBankLine('a_new', 'Neu', 300)] }),
      approve_drafted_action: ok({ status: 'executed' }),
    });
    await waitFor(() => expect(boxes()).toHaveLength(2));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Alle Vorschläge auswählen' }));
    // The person refreshes: a third bank Vorschlag arrives.
    await userEvent.click(screen.getByRole('button', { name: 'Aktualisieren' }));
    await waitFor(() => expect(boxes()).toHaveLength(3));
    expect(boxes().map((b) => b.checked)).toEqual([true, true, false]);
    await userEvent.click(screen.getByRole('button', { name: 'Ausgewählte genehmigen (2)' }));
    await screen.findByText('2 genehmigt.');
    expect(calls.filter((c) => c.action === 'approve_drafted_action').map((c) => c.input.actionId)).toEqual(['a1', 'a2']);
  });

  it('a ticked row that comes back changed (stale) loses its box and is not run; nothing posts the changed record', async () => {
    const { calls } = renderHub({
      attention_list: reads(
        groupedOf([bankVorschlag('a1'), bankVorschlag('a2'), bankVorschlag('a3')]),
        // The engine stops marking a changed row batchable (round 2); the Studio's own check holds too.
        groupedOf([bankVorschlag('a1'), bankVorschlag('a2', { changedSinceProposal: true }), bankVorschlag('a3')]),
      ),
      list_drafted_actions: ok({ actions: [draftedBankLine('a1', 'Eins', 100), draftedBankLine('a2', 'Zwei', 200), draftedBankLine('a3', 'Drei', 300)] }),
      approve_drafted_action: ok({ status: 'executed' }),
    });
    await waitFor(() => expect(boxes()).toHaveLength(3));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Alle Vorschläge auswählen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Aktualisieren' }));
    await waitFor(() => expect(boxes()).toHaveLength(2));
    await userEvent.click(screen.getByRole('button', { name: 'Ausgewählte genehmigen (2)' }));
    await screen.findByText('2 genehmigt.');
    expect(calls.filter((c) => c.action === 'approve_drafted_action').map((c) => c.input.actionId)).toEqual(['a1', 'a3']);
  });

  it('a double click on "Ausgewählte genehmigen" runs each row once; the batch never sends allowFuture', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { calls } = renderHub({
      attention_list: reads(groupedOf([bankVorschlag('a1'), bankVorschlag('a2')]), groupedOf([])),
      list_drafted_actions: ok({ actions: [draftedBankLine('a1', 'Eins', 100), draftedBankLine('a2', 'Zwei', 200)] }),
      approve_drafted_action: async () => {
        await gate;
        return ok({ status: 'executed' });
      },
    });
    await waitFor(() => expect(boxes()).toHaveLength(2));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Alle Vorschläge auswählen' }));
    const button = screen.getByRole('button', { name: 'Ausgewählte genehmigen (2)' });
    await userEvent.dblClick(button);
    release();
    await screen.findByText('2 genehmigt.');
    const approvals = calls.filter((c) => c.action === 'approve_drafted_action');
    expect(approvals.map((c) => c.input.actionId)).toEqual(['a1', 'a2']);
    expect(approvals.every((c) => c.input.allowFuture === undefined)).toBe(true);
  });

  it('the aggregate bank-lines row is never a batch row', async () => {
    renderHub({
      attention_list: ok(groupedOf([bankVorschlag('a1'), bankVorschlag('a2'), linesRow(5)])),
      list_drafted_actions: ok({ actions: [draftedBankLine('a1', 'Eins', 100), draftedBankLine('a2', 'Zwei', 200)] }),
    });
    await screen.findByText('5 Bankzeilen zu buchen');
    expect(boxes()).toHaveLength(2);
  });
});
