/**
 * G15 F-01: the row carries its decision, in D178's one row pattern (one button, the rest in the ⋯, the
 * reason and the consequence behind the (i)). Rendered through the whole hub from a canned grouped
 * `attention_list`, so every assertion is about what the person sees and what the hub SENDS:
 *
 *  - a credit with no candidate offers "Keine Kundenzahlung" and the Abgleich link, never an apply
 *    the engine did not propose; the J8.12 reason sentence and the D118 C4 consequence render; two or
 *    more unassigned payments of one Bankkonto read as one group row, opened on request;
 *  - acting sends the option's verb with EXACTLY its declared input plus the human confirmation,
 *    under the engine's per-item key; the hub re-reads and stays on its route;
 *  - a double click while the verb runs fires ONE call (the in-flight guard);
 *  - the agent row shows the verb's human label (never `override_qr_match`), approve-and-allow sends
 *    the D103 grant, reject confirms in place with a reason; the drafting actor sees no approve;
 *  - an option whose clearing capability the actor lacks is hidden, the link stays;
 *  - a refusal renders the localized sentence and keeps the row;
 *  - the review flag row names who flagged it and why, opens the entry, resolves via approve_entry;
 *  - the dunning run row issues through issue_dunning_run, confirmed, under the engine key;
 *  - axe is clean with the strip rendered.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { MemoryRouter, useLocation } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider, useWorkspace } from '../../app/workspace';
import { CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { Attention } from './index';
import { consequenceSentence } from '../../lib/approval-tiers';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import { groupedOf } from './testing';

type Handler = (input: Record<string, unknown>) => RestResponse | Promise<RestResponse>;
type Canned = Record<string, RestResponse | Handler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const refuse = (error: string): RestResponse => ({ status: 422, body: { ok: false, error } });

function fakeTransport(canned: Canned, calls: { action: string; input: Record<string, unknown> }[]): Transport {
  return async (action, input) => {
    calls.push({ action, input: input as Record<string, unknown> });
    const entry = canned[action];
    if (entry === undefined) return { status: 200, body: { ok: true } };
    return typeof entry === 'function' ? await entry(input as Record<string, unknown>) : entry;
  };
}

/** The grouped answer for these rows (D178: the page reads the whole list in sections). */
const summaryOf = (top: Record<string, unknown>[], _total?: number) => groupedOf(top, { computedAt: '2026-09-05T08:00:00.000Z' });

function creditItem(creditId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const dismiss = { id: 'dismiss', verb: 'override_qr_match', labelKey: 'qrmatch.overrideDismiss', role: 'primary', input: { creditId, action: 'dismiss', idempotencyKey: `attention:dismiss:ws_test:${creditId}:new` }, humanConfirm: true, capability: 'pay' };
  const open = { id: 'open', verb: null, labelKey: 'attention.act.openReconciliation', role: 'link', input: {}, deepLink: { route: '/reconciliation', params: { creditId } } };
  return {
    queueId: 'qr_match',
    entityKind: 'reconciliation_match',
    entityId: creditId,
    titleKey: 'attention.item.qrMatch.title',
    titleParams: {},
    subtitleKey: 'attention.item.qrMatch.subtitle',
    subtitleParams: { payer: '', bank: 'PostFinance' },
    amountMinor: 57000,
    currency: 'CHF',
    since: '2026-08-21',
    urgency: 'open',
    deepLink: { route: '/reconciliation', params: { creditId } },
    decisionOptions: [dismiss, open],
    suggestedInvoiceId: null,
    suggestedInvoiceNumber: null,
    reasonCode: 'no_invoice',
    reasonKey: 'qrmatch.reason.no_invoice',
    // A dismiss-only row books nothing, so the engine sends no sentence (F1 of the critic report).
    consequenceKey: null,
    consequence: null,
    ...over,
  };
}

function draftItem(actionId: string, tool = 'override_qr_match', proposedBy = 'agent'): Record<string, unknown> {
  return {
    queueId: 'agent_action',
    entityKind: 'agent_action',
    entityId: actionId,
    titleKey: 'attention.item.agentAction.title',
    titleParams: {},
    subtitleKey: 'attention.item.agentAction.subtitle',
    subtitleParams: { tool },
    since: '2026-09-05T07:00:00.000Z',
    urgency: 'open',
    deepLink: { route: '/agent', params: { actionId } },
    proposedBy,
    decisionOptions: [
      { id: 'approve', verb: 'approve_drafted_action', labelKey: 'agent.card.approve', role: 'primary', input: { actionId }, capability: 'manage_agent_dial' },
      { id: 'approve_allow', verb: 'approve_drafted_action', labelKey: 'agent.card.approveAllow', role: 'secondary', input: { actionId, allowFuture: true }, capability: 'manage_agent_dial', hintKey: 'agent.card.grantHint' },
      { id: 'reject', verb: 'reject_drafted_action', labelKey: 'agent.card.reject', role: 'danger', input: { actionId }, capability: 'manage_agent_dial', reasonField: true },
    ],
    consequenceKey: 'agent.consequence.pay',
    consequence: 'Re-points or reverses a queued match.',
  };
}

function flagItem(entryId: string, who: { proposedBy: string; proposedByKind: string; reviewer: string } = { proposedBy: 'member:user_3', proposedByKind: 'member', reviewer: 'Reto Muster' }): Record<string, unknown> {
  return {
    queueId: 'review_flag',
    entityKind: 'journal_entry',
    entityId: entryId,
    titleKey: 'attention.item.reviewFlag.title',
    titleParams: {},
    subtitleKey: 'attention.item.reviewFlag.subtitle',
    subtitleParams: { date: '2026-07-03', description: 'Honorar Juli', reviewer: who.reviewer, reason: 'Falsches Konto: Aufwand statt Ertrag' },
    since: '2026-09-05T07:30:00.000Z',
    urgency: 'open',
    deepLink: { route: '/journal', params: { entryId } },
    proposedBy: who.proposedBy,
    proposedByKind: who.proposedByKind,
    proposedByName: who.reviewer === '' ? null : who.reviewer,
    decisionOptions: [
      { id: 'open', verb: null, labelKey: 'attention.act.openEntry', role: 'link', input: {}, deepLink: { route: '/journal', params: { entryId } } },
      { id: 'resolve', verb: 'approve_entry', labelKey: 'attention.act.resolveFlag', role: 'secondary', input: { entryId, idempotencyKey: `attention:resolve:ws_test:${entryId}:rev_1` }, capability: 'review' },
    ],
    reasonCode: 'flagged',
    reasonKey: 'attention.item.reviewFlag.reason',
    consequenceKey: null,
    consequence: null,
  };
}

function dunningItem(runId: string): Record<string, unknown> {
  return {
    queueId: 'dunning_run',
    entityKind: 'dunning_run',
    entityId: runId,
    titleKey: 'attention.item.dunningRun.title',
    titleParams: {},
    subtitleKey: 'attention.item.dunningRun.subtitle',
    subtitleParams: { count: 3, date: '2026-09-01' },
    since: '2026-09-01',
    urgency: 'open',
    deepLink: { route: '/dunning', params: { runId } },
    decisionOptions: [
      { id: 'issue', verb: 'issue_dunning_run', labelKey: 'attention.act.issueDunningRun', role: 'primary', input: { runId, idempotencyKey: `attention:issue:ws_test:${runId}` }, humanConfirm: true, capability: 'dun' },
      { id: 'open', verb: null, labelKey: 'attention.act.openDunning', role: 'link', input: {}, deepLink: { route: '/dunning', params: { runId } } },
    ],
    consequenceKey: 'agent.consequence.dun',
    consequence: 'Freezes the reminder run, advances each debtor one dunning level and books any fee.',
  };
}

/** A proposed run as `get_dunning_run` reads it: two debtors, three invoices, a CHF 20 fee on each. */
function dunningRun(runId: string, feeMinor = 2000): Record<string, unknown> {
  const item = (documentId: string, debtorId: string) => ({
    documentId,
    debtorId,
    debtorName: debtorId === 'c1' ? 'Bergsicht Velos GmbH' : 'Seeblick Gastro AG',
    number: documentId,
    level: 1,
    currency: 'CHF',
    overdueMinor: 48000,
    feeMinor,
    demandedFeeMinor: 0,
    feeBooked: false,
    interestMinor: null,
    daysOverdue: 12,
    dueDate: '2026-08-20',
  });
  return {
    runId,
    runDate: '2026-09-01',
    status: 'proposed',
    items: [item('RE-1', 'c1'), item('RE-2', 'c1'), item('RE-3', 'c2')],
    debtors: [
      { debtorId: 'c1', debtorName: 'Bergsicht Velos GmbH', itemCount: 2, maxLevel: 1, totalsByCurrency: { CHF: 96000 } },
      { debtorId: 'c2', debtorName: 'Seeblick Gastro AG', itemCount: 1, maxLevel: 1, totalsByCurrency: { CHF: 48000 } },
    ],
  };
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderHub(canned: Canned, caps?: Partial<Capabilities>) {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const client = new TillClient(fakeTransport(canned, calls));
  const capabilities: Capabilities = { whoami: null, can: () => true, refresh: () => undefined, ...caps };
  const view = render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesContext.Provider value={capabilities}>
            <MemoryRouter initialEntries={['/attention']}>
              <Attention />
              <Where />
            </MemoryRouter>
          </CapabilitiesContext.Provider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
  return { ...view, calls };
}

/** A summary that answers the seeded rows first and an empty queue after the first act. */
function shrinkingSummary(top: Record<string, unknown>[]): Handler {
  let reads = 0;
  return () => {
    reads += 1;
    return ok(reads === 1 ? summaryOf(top) : summaryOf([], 0));
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('the credit row', () => {
  it('renders the reason sentence and the two exits, states NO posting on a dismiss-only row, and offers no apply the engine did not propose', async () => {
    renderHub({ attention_list: ok(summaryOf([creditItem('c1')])) });
    expect(await screen.findByText('Zahlung ohne Zuordnung')).toBeInTheDocument();
    expect(screen.getByText(/Keine offene Rechnung zu dieser Referenz/)).toBeInTheDocument();
    // "Keine Kundenzahlung" books nothing: the pay sentence would describe a write this row cannot make.
    expect(screen.queryByText('Bucht eine Zahlung und gleicht offene Posten aus.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keine Kundenzahlung' })).toBeInTheDocument();
    // D178: ONE button per row; the link into the owning surface sits in the ⋯.
    expect(screen.queryByRole('button', { name: 'Im Abgleich öffnen' })).not.toBeInTheDocument();
    // The reason is words on demand: in the (i), not on the face.
    expect(document.querySelector('.att-row-meta')?.textContent ?? '').not.toMatch(/Keine offene Rechnung/);
    expect(screen.queryByRole('button', { name: /^Übernehmen$/ })).not.toBeInTheDocument();
  });

  it('D167 polish 11: an item whose only exit is a link carries it INSIDE its row, with the same quiet ⋯, no detached strip', async () => {
    const open = { id: 'open', verb: null, labelKey: 'attention.act.openReconciliation', role: 'link', input: {}, deepLink: { route: '/reconciliation', params: { creditId: 'c9' } } };
    renderHub({ attention_list: ok(summaryOf([creditItem('c9', { decisionOptions: [open], reasonKey: null })])) });
    const link = await screen.findByRole('button', { name: 'Im Abgleich öffnen' });
    expect(link.closest('.att-row-line')).not.toBeNull();
    expect(document.querySelector('.att-decide')).toBeNull();
    const more = link.closest('.att-row-line')?.querySelector('.att-row-more button') as HTMLElement;
    expect(more.className).toMatch(/quiet|ghost/);
  });

  it('K-40: the decision button is the same secondary on the focused row and on every other row', async () => {
    // Two Bankkonten, so the two payments stay two rows (one Bankkonto would group them).
    const { container } = renderHub({
      attention_list: ok(summaryOf([creditItem('c1'), creditItem('c2', { subtitleParams: { payer: '', bank: 'Raiffeisen' } })])),
    });
    const buttons = await screen.findAllByRole('button', { name: 'Keine Kundenzahlung' });
    expect(buttons).toHaveLength(2);
    // The events zone reads on its own; let it settle so its update never lands after the test (act()).
    await waitFor(() => expect(container.querySelector('.att-events-empty[role="status"]')).toBeNull());
    for (const button of buttons) {
      expect(button).toHaveClass('btn--secondary');
      expect(button).not.toHaveClass('btn--primary');
    }
    // The focused entry is marked by its pill tint (aria-current on the row's way in, its one button: no
    // title is a button, N4 M4) alone. Nothing is current on arrival (D152 rule 5); focusing makes it so.
    const openers = screen.getAllByRole('button', { name: 'Keine Kundenzahlung' });
    expect(openers[0]).not.toHaveAttribute('aria-current');
    act(() => openers[0].focus());
    expect(openers[0]).toHaveAttribute('aria-current', 'true');
    for (const button of screen.getAllByRole('button', { name: 'Keine Kundenzahlung' })) {
      expect(button).toHaveClass('btn--secondary');
    }
  });

  it('two or more unassigned payments of one Bankkonto read as ONE row with their count and money; each keeps its decision when opened', async () => {
    const { container } = renderHub({
      attention_list: ok(summaryOf([creditItem('c1'), creditItem('c2', { amountMinor: 12000 }), creditItem('c3', { subtitleParams: { payer: '', bank: 'Raiffeisen' } })])),
    });
    const group = await screen.findByText('2 Zahlungen ohne Zuordnung');
    // The events zone reads on its own; let it settle so its update never lands after the test (act()).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const item = group.closest('[data-row-count]') as HTMLElement;
    expect(item.getAttribute('data-row-count')).toBe('2');
    expect(item.textContent ?? '').toMatch(/CHF\s?690\.00/);
    // Closed: the two payments are not on the page yet; the lone one of the other Bankkonto is its own row.
    expect(screen.getAllByRole('button', { name: 'Keine Kundenzahlung' })).toHaveLength(1);
    // N4 M5: the button names the job, and the group has the (i) and the ⋯ every row has.
    const open = within(item).getByRole('button', { name: 'Zahlungen zuordnen' });
    expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(within(item).getByRole('button', { name: 'Info' })).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: /Aktionen für 2 Zahlungen ohne Zuordnung/ })).toBeInTheDocument();
    // Its total is one signed figure, its sign (if any) in the danger ink only; no glyph in the lead column.
    expect(item.querySelector('.att-lead')?.childElementCount).toBe(0);
    fireEvent.click(open);
    expect(within(item).getByRole('button', { name: 'Ausblenden' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(item).getAllByRole('button', { name: 'Keine Kundenzahlung' })).toHaveLength(2);
    // The section still adds up: the group row stands for its members, the members are not counted twice.
    const units = [...container.querySelectorAll('[data-section="bank"] [data-row-count]')]
      .filter((r) => r.closest('[data-member]') === null)
      .reduce((n, r) => n + Number(r.getAttribute('data-row-count')), 0);
    expect(units).toBe(3);
  });

  it('with a suggested invoice the apply act leads and the suggestion is named', async () => {
    const apply = { id: 'apply', verb: 'apply_qr_match', labelKey: 'qrmatch.applyFull', role: 'primary', input: { creditId: 'c2', invoiceId: 'doc_9', mode: 'full', idempotencyKey: 'attention:apply:ws_test:c2:doc_9:full:new' }, humanConfirm: true, capability: 'pay' };
    const item = creditItem('c2', { suggestedInvoiceId: 'doc_9', suggestedInvoiceNumber: 'R-2026-0009', reasonCode: 'exact_open', reasonKey: 'qrmatch.reason.exact_open', consequenceKey: 'agent.consequence.pay', consequence: 'Books a payment and settles open items.' });
    item.decisionOptions = [apply, ...(item.decisionOptions as Record<string, unknown>[]).map((o) => ({ ...o, role: o.id === 'dismiss' ? 'secondary' : o.role }))];
    const { calls } = renderHub({ attention_list: shrinkingSummary([item]), apply_qr_match: ok({ paymentId: 'p1' }) });
    expect(await screen.findByText(/Vorschlag: R-2026-0009/)).toBeInTheDocument();
    expect(screen.getByText(/Referenz und Betrag stimmen genau/)).toBeInTheDocument();
    // With an apply on the row, the apply's own engine sentence is due and renders (D118 C4, D156).
    expect(screen.getByText(consequenceSentence('apply_qr_match', 'de-CH') as string)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }));
    await screen.findByText('Zahlung übernommen und gebucht.');
    const sent = calls.find((c) => c.action === 'apply_qr_match');
    expect(sent?.input).toEqual({ workspaceId: 'ws_test', creditId: 'c2', invoiceId: 'doc_9', mode: 'full', idempotencyKey: 'attention:apply:ws_test:c2:doc_9:full:new', confirmed: true });
  });

  it('"Keine Kundenzahlung" sends override_qr_match with the declared input, confirmed, under the engine key; the row leaves in place, no route change', async () => {
    const { calls } = renderHub({ attention_list: shrinkingSummary([creditItem('c1')]), override_qr_match: ok({}) });
    await screen.findByText('Zahlung ohne Zuordnung');
    fireEvent.click(screen.getByRole('button', { name: 'Keine Kundenzahlung' }));
    const done = await screen.findByText('Abgelegt: keine Kundenzahlung.');
    // The Commit moment (D122 D-I): the row leaves, so the acknowledgement lands on the banner.
    expect(done.closest('.action-feedback')?.hasAttribute('data-just-committed')).toBe(true);
    const sent = calls.filter((c) => c.action === 'override_qr_match');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toEqual({ workspaceId: 'ws_test', creditId: 'c1', action: 'dismiss', idempotencyKey: 'attention:dismiss:ws_test:c1:new', confirmed: true });
    // The list re-read and is empty: the celebratory state, on the same route.
    expect(await screen.findByText('Nichts wartet auf dich.')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/attention');
    expect(calls.filter((c) => c.action === 'attention_list').length).toBeGreaterThanOrEqual(2);
  });

  it('a double click while the verb runs fires exactly ONE call', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = renderHub({
      attention_list: shrinkingSummary([creditItem('c1')]),
      override_qr_match: async () => {
        await gate;
        return ok({});
      },
    });
    await screen.findByText('Zahlung ohne Zuordnung');
    const button = screen.getByRole('button', { name: 'Keine Kundenzahlung' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(screen.getByText('Wird ausgeführt')).toBeInTheDocument();
    release!();
    await screen.findByText('Abgelegt: keine Kundenzahlung.');
    expect(calls.filter((c) => c.action === 'override_qr_match')).toHaveLength(1);
  });

  it('a refusal renders the localized sentence and keeps the row', async () => {
    renderHub({ attention_list: ok(summaryOf([creditItem('c1')])), override_qr_match: refuse('period_locked') });
    await screen.findByText('Zahlung ohne Zuordnung');
    fireEvent.click(screen.getByRole('button', { name: 'Keine Kundenzahlung' }));
    const refusal = await screen.findByText('Die Periode ist gesperrt: dort kann nichts mehr gebucht werden.');
    expect(refusal).toBeInTheDocument();
    // A refusal is not a commit: nothing lands.
    expect(refusal.closest('.action-feedback')?.hasAttribute('data-just-committed')).toBe(false);
    expect(screen.getByText('Zahlung ohne Zuordnung')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keine Kundenzahlung' })).toBeEnabled();
  });

  it('the Abgleich link opens the owning surface for the hard case', async () => {
    renderHub({ attention_list: ok(summaryOf([creditItem('c1')])) });
    await screen.findByText('Zahlung ohne Zuordnung');
    fireEvent.click(screen.getByRole('button', { name: /Aktionen für Zahlung ohne Zuordnung/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Im Abgleich öffnen' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/reconciliation?creditId=c1'));
  });
});

describe('the agent proposal row (D167: the Vorschlag line, decided here)', () => {
  const TITLE = 'Zuordnung der QR-Zahlung korrigieren';
  const MORE = `Mehr zu: ${TITLE}`;

  it('one line: the drafted verb in words (never the raw id), the agent named, Genehmigen as a secondary, the rest in the ⋯', async () => {
    renderHub({ attention_list: ok(summaryOf([draftItem('a1')])) });
    // N4 M4: the title is words; the line's one button is the way in.
    expect(await screen.findByText(TITLE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: TITLE })).not.toBeInTheDocument();
    expect(screen.getByText('Vorschlag des Agenten')).toBeInTheDocument();
    expect(screen.queryByText('override_qr_match')).not.toBeInTheDocument();
    const approve = screen.getByRole('button', { name: 'Genehmigen' });
    expect(approve.className).toContain('btn--secondary');
    // Nothing else decides on the face: the grant and the reject sit in the one overflow.
    expect(screen.queryByRole('button', { name: 'Genehmigen und künftig automatisch' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ablehnen' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: MORE }));
    const items = (await screen.findAllByRole('menuitem')).map((i) => i.textContent);
    expect(items).toEqual(['Details', 'Genehmigen und künftig automatisch', 'Aufgabe erstellen', 'Referenz kopieren', 'Ablehnen']);
  });

  it('the consequence sits behind the (i) as a real tooltip, and Genehmigen is described by the same words', async () => {
    renderHub({ attention_list: ok(summaryOf([draftItem('a1')])) });
    const approve = await screen.findByRole('button', { name: 'Genehmigen' });
    const info = screen.getByRole('button', { name: 'Was das bewirkt' });
    const tip = document.getElementById(info.getAttribute('aria-describedby') ?? '');
    expect(tip?.getAttribute('role')).toBe('tooltip');
    const sentence = tip?.textContent ?? '';
    expect(sentence.length).toBeGreaterThan(0);
    expect(document.getElementById(approve.getAttribute('aria-describedby') ?? '')?.textContent).toBe(sentence);
    // Not a paragraph on the face: the only visible copy is the tooltip bubble.
    expect(document.querySelector('.att-decide-consequence')).toBeNull();
  });

  it('Genehmigen sends the declared approve exactly as declared', async () => {
    const { calls } = renderHub({ attention_list: shrinkingSummary([draftItem('a1')]), approve_drafted_action: ok({}) });
    fireEvent.click(await screen.findByRole('button', { name: 'Genehmigen' }));
    expect(await screen.findByText('Vorschlag genehmigt und ausgeführt.')).toBeInTheDocument();
    const sent = calls.filter((c) => c.action === 'approve_drafted_action');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toEqual({ workspaceId: 'ws_test', actionId: 'a1' });
  });

  it('"Genehmigen und künftig automatisch" confirms in place with the grant sentence, then is ONE act sending allowFuture', async () => {
    const { calls } = renderHub({ attention_list: shrinkingSummary([draftItem('a1')]), approve_drafted_action: ok({}) });
    fireEvent.click(await screen.findByRole('button', { name: MORE }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Genehmigen und künftig automatisch' }));
    expect(await screen.findByText(/bleibt jederzeit widerrufbar/)).toBeInTheDocument();
    expect(calls.filter((c) => c.action === 'approve_drafted_action')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Genehmigen und erlauben' }));
    expect(await screen.findByText(/Diese Art führt der Agent künftig direkt aus/)).toBeInTheDocument();
    const sent = calls.filter((c) => c.action === 'approve_drafted_action');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toEqual({ workspaceId: 'ws_test', actionId: 'a1', allowFuture: true });
  });

  it('"Ablehnen" confirms in place with a reason and sends it; a rejected draft reports that nothing was posted', async () => {
    const { calls } = renderHub({ attention_list: shrinkingSummary([draftItem('a1')]), reject_drafted_action: ok({}) });
    fireEvent.click(await screen.findByRole('button', { name: MORE }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ablehnen' }));
    const field = await screen.findByLabelText('Begründung (optional)');
    fireEvent.change(field, { target: { value: 'Falsche Rechnung' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ja, ablehnen' }));
    expect(await screen.findByText('Vorschlag abgelehnt. Gebucht wurde nichts.')).toBeInTheDocument();
    const sent = calls.filter((c) => c.action === 'reject_drafted_action');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toEqual({ workspaceId: 'ws_test', actionId: 'a1', reason: 'Falsche Rechnung' });
  });

  it('Details: the drafted payload as label and value pairs, the Freigabe level from the dial, never JSON', async () => {
    const { container } = renderHub({
      attention_list: ok(summaryOf([draftItem('a1', 'post_entry')])),
      list_drafted_actions: ok({
        actions: [
          {
            actionId: 'a1',
            actor: 'agent',
            dialCapability: 'post',
            actionTool: 'post_entry',
            payload: { workspaceId: 'ws_test', date: '2026-09-04', source: 'manual', idempotencyKey: 'k-idem-1', lines: [{ account: 'acc_50', debit: 50000 }, { account: 'acc_2', credit: 50000 }] },
            status: 'pending',
            createdAt: '2026-09-05T07:00:00.000Z',
          },
        ],
      }),
      get_agent_dial: ok({ rows: [{ capability: 'post', stored: 'ask', effective: 'ask', strongDefault: false }] }),
      // The PINNED recording (acc_50 is 6500, acc_2 is 1020), never hand-typed accounts.
      list_accounts: ok({ accounts: listAccountsFixture.accounts }),
    });
    // Details open from the ⋯ (the title is words, N4 M4).
    fireEvent.click(await screen.findByRole('button', { name: 'Mehr zu: Buchung erfassen' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Details' }));
    await waitFor(() => expect(container.querySelector('.vorschlag-readback')?.textContent ?? '').toContain('Fragt nach'));
    const text = container.querySelector('.vorschlag-readback')?.textContent ?? '';
    expect(text).toContain('Datum04.09.2026');
    // D167 polish 11: each leg one line, the side, the account in words, the money; no "Betrag" repeating them.
    expect(text).toContain("Soll6500 Verwaltungs- und Bürokosten · CHF 500.00");
    expect(text).not.toContain('Betrag');
    expect(text).toContain('am 05.09.2026 von Agent');
    for (const raw of ['{', 'workspaceId', 'idempotencyKey', 'post_entry', 'debit', 'k-idem-1']) expect(text).not.toContain(raw);
    // D167 browser walk: the accounts by number and name, the source in words, never an internal id.
    await waitFor(() => expect(container.querySelector('.vorschlag-readback')?.textContent ?? '').toContain('6500 Verwaltungs- und Bürokosten'));
    const named = container.querySelector('.vorschlag-readback')?.textContent ?? '';
    expect(named).toContain('Haben1020 Bankkonto · CHF 500.00');
    // No "Quelle" row (it read "Manuell" beside "von Agent").
    expect(named).not.toContain('Quelle');
    expect(named).not.toMatch(/acc_\d/);
  });

  it('the drafting actor sees no approve on their own proposal, and the reason is named', async () => {
    renderHub(
      { attention_list: ok(summaryOf([draftItem('a1', 'post_entry', 'agent')])) },
      { whoami: { actor: 'agent', provisioned: true, isMember: true, memberId: 'm1', userId: 'u1', role: 'owner', capabilities: ['manage_agent_dial'] } },
    );
    await screen.findByText('Buchung erfassen');
    expect(screen.queryByRole('button', { name: 'Genehmigen' })).not.toBeInTheDocument();
    expect(screen.getByText('Der eigene Vorschlag braucht eine zweite Person zur Freigabe.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mehr zu: Buchung erfassen' }));
    await screen.findByRole('menuitem', { name: 'Details' });
    expect(screen.queryByRole('menuitem', { name: 'Ablehnen' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Genehmigen und künftig automatisch' })).toBeNull();
  });

  it('an actor without manage_agent_dial sees no approve control at all (hidden, never refused); the line still opens its Details', async () => {
    renderHub({ attention_list: ok(summaryOf([draftItem('a1')])) }, { can: (cap) => cap !== 'manage_agent_dial' });
    await screen.findByText(TITLE);
    expect(screen.queryByRole('button', { name: 'Genehmigen' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Benötigt: Agent-Freigabe' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: MORE }));
    await screen.findByRole('menuitem', { name: 'Details' });
    expect(screen.queryByRole('menuitem', { name: 'Ablehnen' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Genehmigen und künftig automatisch' })).toBeNull();
  });

  it('a bank-line Vorschlag links to its line', async () => {
    renderHub({
      attention_list: ok(summaryOf([draftItem('a1', 'book_bank_line')])),
      list_drafted_actions: ok({
        actions: [{ actionId: 'a1', actor: 'agent', dialCapability: 'pay', actionTool: 'book_bank_line', payload: { bankTxnId: 'btx_9', target: { kind: 'accounts', legs: [] } }, status: 'pending', createdAt: '2026-09-05T07:00:00.000Z' }],
      }),
    });
    // D178: the meta line carries values only; the link to the line sits in the ⋯.
    fireEvent.click(await screen.findByRole('button', { name: 'Mehr zu: Bankzeile buchen' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Zur Bankzeile' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/bank?line=btx_9'));
  });
});

describe('the review flag row', () => {
  it('names who flagged the entry and why, opens the entry, and resolves through approve_entry with no invented consequence', async () => {
    const { calls } = renderHub({ attention_list: shrinkingSummary([flagItem('e1')]), approve_entry: ok({}) });
    expect(await screen.findByText('Buchung beanstandet')).toBeInTheDocument();
    // A member is named by the display name the engine resolved, never by the served actor id.
    expect(screen.getByText('Markiert von Reto Muster: Falsches Konto: Aufwand statt Ertrag')).toBeInTheDocument();
    expect(screen.queryByText(/member:user_3/)).not.toBeInTheDocument();
    expect(screen.getByText(/Honorar Juli · 03\.07\.2026/)).toBeInTheDocument();
    expect(screen.queryByText(consequenceSentence('post_entry', 'de-CH') as string)).not.toBeInTheDocument();
    // The title and "Buchung öffnen" open the same entry: the title is words, the button is the one way in.
    const line = screen.getByText('Buchung beanstandet').closest('.att-row') as HTMLElement;
    expect(within(line).queryByRole('button', { name: 'Buchung beanstandet' })).toBeNull();
    expect(within(line).getByRole('button', { name: 'Buchung öffnen' })).toBeInTheDocument();
    // The resolve is the second exit: it sits in the row's ⋯.
    expect(within(line).queryByRole('button', { name: 'Als geprüft freigeben' })).toBeNull();
    fireEvent.click(within(line).getByRole('button', { name: /Aktionen für Buchung beanstandet/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Als geprüft freigeben' }));
    expect(await screen.findByText('Markierung erledigt, Buchung freigegeben.')).toBeInTheDocument();
    const sent = calls.filter((c) => c.action === 'approve_entry');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toEqual({ workspaceId: 'ws_test', entryId: 'e1', idempotencyKey: 'attention:resolve:ws_test:e1:rev_1' });
  });

  it('names the agent seat and the Studio seat in words, and prints no id for an actor the engine cannot place', async () => {
    renderHub({
      attention_list: ok(summaryOf([
        flagItem('e1', { proposedBy: 'agent', proposedByKind: 'agent', reviewer: '' }),
        flagItem('e2', { proposedBy: 'studio', proposedByKind: 'studio', reviewer: '' }),
        flagItem('e3', { proposedBy: 'reto', proposedByKind: 'unknown', reviewer: '' }),
      ], 3)),
    });
    expect(await screen.findByText('Markiert durch den Agenten: Falsches Konto: Aufwand statt Ertrag')).toBeInTheDocument();
    expect(screen.getByText('Markiert im Studio: Falsches Konto: Aufwand statt Ertrag')).toBeInTheDocument();
    expect(screen.getByText('Markiert: Falsches Konto: Aufwand statt Ertrag')).toBeInTheDocument();
    expect(screen.queryByText(/Markiert von agent|Markiert von studio|Markiert von reto/)).not.toBeInTheDocument();
  });

  it('"Von dir markiert" when the flag is the viewer\'s own, matched on the raw actor id', async () => {
    renderHub(
      { attention_list: ok(summaryOf([flagItem('e1')])) },
      { whoami: { actor: 'member:user_3', provisioned: true, isMember: true, memberId: 'm3', userId: 'user_3', role: 'treuhaender', capabilities: ['review'] } },
    );
    expect(await screen.findByText('Von dir markiert: Falsches Konto: Aufwand statt Ertrag')).toBeInTheDocument();
  });

  it('the link opens the Journal with the entry named', async () => {
    renderHub({ attention_list: ok(summaryOf([flagItem('e1')])) });
    await screen.findByText('Buchung beanstandet');
    fireEvent.click(screen.getByRole('button', { name: 'Buchung öffnen' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/journal?entryId=e1'));
  });
});

describe('the dunning run row', () => {
  it('names the run; "Mahnlauf ausstellen" opens the governed confirm and sends NOTHING; only its commit sends issue_dunning_run confirmed under the engine key', async () => {
    const { calls } = renderHub({
      attention_list: shrinkingSummary([dunningItem('run_1')]),
      get_dunning_run: ok(dunningRun('run_1')),
      issue_dunning_run: ok({ runId: 'run_1', status: 'issued' }),
    });
    expect(await screen.findByText('Mahnlauf bereit zum Ausstellen')).toBeInTheDocument();
    expect(screen.getByText('3 Rechnungen · 01.09.2026')).toBeInTheDocument();
    // The orchestrator's N4 ruling: every row action is the quiet secondary; the page's one accent is the
    // batch commit, so the Mahnlauf's issue carries neither the tint nor a money-commit claim.
    const quiet = screen.getByRole('button', { name: 'Mahnlauf ausstellen' });
    expect(quiet).toHaveClass('btn--secondary');
    expect(quiet).not.toHaveClass('btn--accent');
    expect(quiet).not.toHaveAttribute('data-money-commit');
    // D178: behind the (i) and as the description of its own commit, never a paragraph at rest.
    const sentence = consequenceSentence('issue_dunning_run', 'de-CH') as string;
    const issueButton = screen.getByRole('button', { name: 'Mahnlauf ausstellen' });
    expect(document.getElementById(issueButton.getAttribute('aria-describedby') ?? '')?.textContent).toBe(sentence);
    expect(screen.getByRole('button', { name: 'Info' }).closest('.tooltip-wrap')?.querySelector('[role="tooltip"]')?.textContent).toContain(sentence);
    expect(screen.queryByText('issue_dunning_run')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mahnlauf ausstellen' }));
    // C4 (D118): the row's button opens the confirm; nothing has left the surface.
    const dialog = await screen.findByRole('alertdialog', { name: 'Mahnlauf ausstellen?' });
    expect(calls.filter((c) => c.action === 'issue_dunning_run')).toHaveLength(0);
    // The engine's ONE sentence, and the run's own facts: Mahnungen, invoices, the fees per currency.
    expect(within(dialog).getByText(sentence)).toBeInTheDocument();
    expect(await within(dialog).findByText('2 Mahnungen · 3 Rechnungen')).toBeInTheDocument();
    expect(within(dialog).getByText(/Gebühren CHF\s?60\.00/)).toBeInTheDocument();
    expect(calls.filter((c) => c.action === 'get_dunning_run').map((c) => c.input)).toEqual([{ workspaceId: 'ws_test', runId: 'run_1' }]);
    // The commit books the fees: the money tint, its verb named for the accent guard, the page's one accent.
    const commit = within(dialog).getByRole('button', { name: 'Mahnlauf ausstellen' });
    expect(commit).toHaveClass('btn--accent');
    expect(commit).toHaveAttribute('data-money-commit', 'issue_dunning_run');
    expect(document.querySelectorAll('.btn--accent')).toHaveLength(1);
    expect(calls.filter((c) => c.action === 'issue_dunning_run')).toHaveLength(0);
    fireEvent.click(commit);
    expect(await screen.findByText('Mahnlauf ausgestellt.')).toBeInTheDocument();
    const sent = calls.filter((c) => c.action === 'issue_dunning_run');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toEqual({ workspaceId: 'ws_test', runId: 'run_1', idempotencyKey: 'attention:issue:ws_test:run_1', confirmed: true });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/attention');
  });

  it('Abbrechen and Escape leave the confirm with nothing written', async () => {
    const { calls } = renderHub({ attention_list: ok(summaryOf([dunningItem('run_1')])), get_dunning_run: ok(dunningRun('run_1')) });
    await screen.findByText('Mahnlauf bereit zum Ausstellen');
    fireEvent.click(screen.getByRole('button', { name: 'Mahnlauf ausstellen' }));
    let dialog = await screen.findByRole('alertdialog', { name: 'Mahnlauf ausstellen?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Mahnlauf ausstellen' }));
    dialog = await screen.findByRole('alertdialog', { name: 'Mahnlauf ausstellen?' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(calls.filter((c) => c.action === 'issue_dunning_run')).toHaveLength(0);
    expect(screen.getByText('Mahnlauf bereit zum Ausstellen')).toBeInTheDocument();
  });

  it('a run with no fee to book: the commit is the plain primary with no money claim, and says nothing is booked', async () => {
    renderHub({ attention_list: ok(summaryOf([dunningItem('run_1')])), get_dunning_run: ok(dunningRun('run_1', 0)) });
    await screen.findByText('Mahnlauf bereit zum Ausstellen');
    fireEvent.click(screen.getByRole('button', { name: 'Mahnlauf ausstellen' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Mahnlauf ausstellen?' });
    expect(await within(dialog).findByText('Keine Gebühren: gebucht wird nichts.')).toBeInTheDocument();
    const commit = within(dialog).getByRole('button', { name: 'Mahnlauf ausstellen' });
    expect(commit).toHaveClass('btn--primary');
    expect(commit).not.toHaveAttribute('data-money-commit');
    expect(commit).toBeEnabled();
  });

  it('a run that cannot be read cannot be issued from here: the commit stays disabled and the confirm says why', async () => {
    const { calls } = renderHub({ attention_list: ok(summaryOf([dunningItem('run_1')])), get_dunning_run: { status: 404, body: { ok: false, error: 'not_found' } } });
    await screen.findByText('Mahnlauf bereit zum Ausstellen');
    fireEvent.click(screen.getByRole('button', { name: 'Mahnlauf ausstellen' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Mahnlauf ausstellen?' });
    expect(await within(dialog).findByText('Der Lauf konnte nicht gelesen werden. Ausstellen geht im Mahnwesen.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Mahnlauf ausstellen' })).toBeDisabled();
    expect(calls.filter((c) => c.action === 'issue_dunning_run')).toHaveLength(0);
  });

  it('an actor without dun sees no issue control (hidden, never refused); the link into the run stays', async () => {
    renderHub({ attention_list: ok(summaryOf([dunningItem('run_1')])) }, { can: (cap) => cap !== 'dun' });
    await screen.findByText('Mahnlauf bereit zum Ausstellen');
    expect(screen.queryByRole('button', { name: 'Mahnlauf ausstellen' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mahnlauf öffnen' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/dunning?runId=run_1'));
  });
});

describe('accessibility', () => {
  it('has no axe violations with decision strips rendered', async () => {
    const { container } = renderHub({
      attention_list: ok(summaryOf([draftItem('a1'), creditItem('c1'), flagItem('e1')], 3)),
      notifications_list: ok({ items: [], unreadCount: 0 }),
    });
    await screen.findByText('Zahlung ohne Zuordnung');
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});

describe('§H-TENANT: an act in flight does not outlive a workspace switch (critic round 2)', () => {
  it('the old workspace act neither locks the new workspace rows nor speaks there', async () => {
    let switchTo: (id: string) => void = () => undefined;
    function Switcher() {
      const { setWorkspaceId } = useWorkspace();
      switchTo = (id: string) => setWorkspaceId(id);
      return null;
    }
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const canned: Canned = {
      attention_list: (input) => ok(summaryOf([creditItem(input.workspaceId === 'ws_b' ? 'c2' : 'c1')])),
      override_qr_match: async (input) => {
        if (input.workspaceId === 'ws_a') await gate;
        return ok({});
      },
    };
    render(
      <TillClientProvider client={new TillClient(fakeTransport(canned, calls))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_a">
            <CapabilitiesContext.Provider value={{ whoami: null, can: () => true, refresh: () => undefined }}>
              <MemoryRouter initialEntries={['/attention']}>
                <Switcher />
                <Attention />
              </MemoryRouter>
            </CapabilitiesContext.Provider>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Keine Kundenzahlung' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'override_qr_match')).toBe(true));
    act(() => switchTo('ws_b'));
    await waitFor(() => expect(calls.some((c) => c.action === 'attention_list' && c.input.workspaceId === 'ws_b')).toBe(true));
    // ws_b's row acts at once: the lock of ws_a's pending act did not come along.
    fireEvent.click(await screen.findByRole('button', { name: 'Keine Kundenzahlung' }));
    await waitFor(() => expect(calls.filter((c) => c.action === 'override_qr_match').map((c) => c.input.workspaceId)).toEqual(['ws_a', 'ws_b']));
    await act(async () => {
      release?.();
      await gate;
    });
  });
});
