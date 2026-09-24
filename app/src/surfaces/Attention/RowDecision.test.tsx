/**
 * G15 F-01: the row carries its decision. Rendered through the whole hub from a canned
 * `attention_summary`, so every assertion is about what the person sees and what the hub SENDS:
 *
 *  - a credit with no candidate offers "Keine Kundenzahlung" and the Abgleich link, never an apply
 *    the engine did not propose; the J8.12 reason sentence and the D118 C4 consequence render;
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
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { MemoryRouter, useLocation } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { Attention } from './index';

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

const summaryOf = (top: Record<string, unknown>[], total = top.length) => ({
  computedAt: '2026-09-05T08:00:00.000Z',
  visibleQueues: 3,
  total,
  incomplete: false,
  queues: total === 0 ? [] : [{ queueId: String(top[0]?.queueId ?? 'qr_match'), area: 'bank', count: total, topUrgency: 'open' }],
  top,
  failed: [],
});

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
    renderHub({ attention_summary: ok(summaryOf([creditItem('c1')])) });
    expect(await screen.findByText('Zahlung ohne Zuordnung')).toBeInTheDocument();
    expect(screen.getByText(/Keine offene Rechnung zu dieser Referenz/)).toBeInTheDocument();
    // "Keine Kundenzahlung" books nothing: the pay sentence would describe a write this row cannot make.
    expect(screen.queryByText('Bucht eine Zahlung und gleicht offene Posten aus.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keine Kundenzahlung' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Im Abgleich öffnen' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Übernehmen$/ })).not.toBeInTheDocument();
  });

  it('K-40: the decision button is the same secondary on the focused row and on every other row', async () => {
    renderHub({ attention_summary: ok(summaryOf([creditItem('c1'), creditItem('c2')])) });
    const buttons = await screen.findAllByRole('button', { name: 'Keine Kundenzahlung' });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toHaveClass('btn--secondary');
      expect(button).not.toHaveClass('btn--primary');
    }
    // The focused entry is marked by its pill tint (aria-current on the row opener) alone.
    const openers = screen.getAllByRole('button').filter((b) => b.className.includes('att-row-open'));
    expect(openers[0]).toHaveAttribute('aria-current', 'true');
  });

  it('with a suggested invoice the apply act leads and the suggestion is named', async () => {
    const apply = { id: 'apply', verb: 'apply_qr_match', labelKey: 'qrmatch.applyFull', role: 'primary', input: { creditId: 'c2', invoiceId: 'doc_9', mode: 'full', idempotencyKey: 'attention:apply:ws_test:c2:doc_9:full:new' }, humanConfirm: true, capability: 'pay' };
    const item = creditItem('c2', { suggestedInvoiceId: 'doc_9', suggestedInvoiceNumber: 'R-2026-0009', reasonCode: 'exact_open', reasonKey: 'qrmatch.reason.exact_open', consequenceKey: 'agent.consequence.pay', consequence: 'Books a payment and settles open items.' });
    item.decisionOptions = [apply, ...(item.decisionOptions as Record<string, unknown>[]).map((o) => ({ ...o, role: o.id === 'dismiss' ? 'secondary' : o.role }))];
    const { calls } = renderHub({ attention_summary: shrinkingSummary([item]), apply_qr_match: ok({ paymentId: 'p1' }) });
    expect(await screen.findByText(/Vorschlag: R-2026-0009/)).toBeInTheDocument();
    expect(screen.getByText(/Referenz und Betrag stimmen genau/)).toBeInTheDocument();
    // With an apply on the row, the pay sentence is due and renders (D118 C4).
    expect(screen.getByText('Bucht eine Zahlung und gleicht offene Posten aus.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }));
    await screen.findByText('Zahlung übernommen und gebucht.');
    const sent = calls.find((c) => c.action === 'apply_qr_match');
    expect(sent?.input).toEqual({ workspaceId: 'ws_test', creditId: 'c2', invoiceId: 'doc_9', mode: 'full', idempotencyKey: 'attention:apply:ws_test:c2:doc_9:full:new', confirmed: true });
  });

  it('"Keine Kundenzahlung" sends override_qr_match with the declared input, confirmed, under the engine key; the row leaves in place, no route change', async () => {
    const { calls } = renderHub({ attention_summary: shrinkingSummary([creditItem('c1')]), override_qr_match: ok({}) });
    await screen.findByText('Zahlung ohne Zuordnung');
    fireEvent.click(screen.getByRole('button', { name: 'Keine Kundenzahlung' }));
    expect(await screen.findByText('Abgelegt: keine Kundenzahlung.')).toBeInTheDocument();
    const sent = calls.filter((c) => c.action === 'override_qr_match');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toEqual({ workspaceId: 'ws_test', creditId: 'c1', action: 'dismiss', idempotencyKey: 'attention:dismiss:ws_test:c1:new', confirmed: true });
    // The list re-read and is empty: the celebratory state, on the same route.
    expect(await screen.findByText('Alles erledigt.')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/attention');
    expect(calls.filter((c) => c.action === 'attention_summary').length).toBeGreaterThanOrEqual(2);
  });

  it('a double click while the verb runs fires exactly ONE call', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = renderHub({
      attention_summary: shrinkingSummary([creditItem('c1')]),
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
    renderHub({ attention_summary: ok(summaryOf([creditItem('c1')])), override_qr_match: refuse('period_locked') });
    await screen.findByText('Zahlung ohne Zuordnung');
    fireEvent.click(screen.getByRole('button', { name: 'Keine Kundenzahlung' }));
    expect(await screen.findByText('Die Periode ist gesperrt: dort kann nichts mehr gebucht werden.')).toBeInTheDocument();
    expect(screen.getByText('Zahlung ohne Zuordnung')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keine Kundenzahlung' })).toBeEnabled();
  });

  it('the Abgleich link opens the owning surface for the hard case', async () => {
    renderHub({ attention_summary: ok(summaryOf([creditItem('c1')])) });
    await screen.findByText('Zahlung ohne Zuordnung');
    fireEvent.click(screen.getByRole('button', { name: 'Im Abgleich öffnen' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/reconciliation?creditId=c1'));
  });
});

describe('the agent proposal row', () => {
  it('names the drafted verb in words, never the raw id, with approve, the D103 grant and reject on the row', async () => {
    renderHub({ attention_summary: ok(summaryOf([draftItem('a1')])) });
    expect(await screen.findByText('Vorschlag wartet auf Genehmigung')).toBeInTheDocument();
    expect(screen.getByText('Zuordnung der QR-Zahlung korrigieren')).toBeInTheDocument();
    expect(screen.queryByText('override_qr_match')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Genehmigen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Genehmigen und künftig automatisch' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ablehnen' })).toBeInTheDocument();
    expect(screen.getByText(/bleibt jederzeit widerrufbar/)).toBeInTheDocument();
  });

  it('"Genehmigen und künftig automatisch" is ONE act and sends allowFuture', async () => {
    const { calls } = renderHub({ attention_summary: shrinkingSummary([draftItem('a1')]), approve_drafted_action: ok({}) });
    await screen.findByText('Vorschlag wartet auf Genehmigung');
    fireEvent.click(screen.getByRole('button', { name: 'Genehmigen und künftig automatisch' }));
    expect(await screen.findByText(/Diese Art führt der Agent künftig direkt aus/)).toBeInTheDocument();
    const sent = calls.filter((c) => c.action === 'approve_drafted_action');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toEqual({ workspaceId: 'ws_test', actionId: 'a1', allowFuture: true });
  });

  it('"Ablehnen" confirms in place with a reason and sends it; a rejected draft reports that nothing was posted', async () => {
    const { calls } = renderHub({ attention_summary: shrinkingSummary([draftItem('a1')]), reject_drafted_action: ok({}) });
    await screen.findByText('Vorschlag wartet auf Genehmigung');
    fireEvent.click(screen.getByRole('button', { name: 'Ablehnen' }));
    const field = screen.getByLabelText('Grund');
    fireEvent.change(field, { target: { value: 'Falsche Rechnung' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ja, ablehnen' }));
    expect(await screen.findByText('Vorschlag abgelehnt. Gebucht wurde nichts.')).toBeInTheDocument();
    const sent = calls.filter((c) => c.action === 'reject_drafted_action');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toEqual({ workspaceId: 'ws_test', actionId: 'a1', reason: 'Falsche Rechnung' });
  });

  it('the drafting actor sees no approve on their own proposal, and the reason is named', async () => {
    renderHub(
      { attention_summary: ok(summaryOf([draftItem('a1', 'post_entry', 'agent')])) },
      { whoami: { actor: 'agent', provisioned: true, isMember: true, memberId: 'm1', userId: 'u1', role: 'owner', capabilities: ['manage_agent_dial'] } },
    );
    await screen.findByText('Vorschlag wartet auf Genehmigung');
    expect(screen.queryByRole('button', { name: 'Genehmigen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ablehnen' })).not.toBeInTheDocument();
    expect(screen.getByText('Der eigene Vorschlag braucht eine zweite Person zur Freigabe.')).toBeInTheDocument();
  });

  it('an actor without manage_agent_dial sees no approve control at all (hidden, never refused), the row itself still opens', async () => {
    renderHub({ attention_summary: ok(summaryOf([draftItem('a1')])) }, { can: (cap) => cap !== 'manage_agent_dial' });
    await screen.findByText('Vorschlag wartet auf Genehmigung');
    expect(screen.queryByRole('button', { name: 'Genehmigen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Genehmigen und künftig automatisch' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ablehnen' })).not.toBeInTheDocument();
  });
});

describe('the review flag row', () => {
  it('names who flagged the entry and why, opens the entry, and resolves through approve_entry with no invented consequence', async () => {
    const { calls } = renderHub({ attention_summary: shrinkingSummary([flagItem('e1')]), approve_entry: ok({}) });
    expect(await screen.findByText('Buchung beanstandet')).toBeInTheDocument();
    // A member is named by the display name the engine resolved, never by the served actor id.
    expect(screen.getByText('Markiert von Reto Muster: Falsches Konto: Aufwand statt Ertrag')).toBeInTheDocument();
    expect(screen.queryByText(/member:user_3/)).not.toBeInTheDocument();
    expect(screen.getByText(/2026-07-03 · Honorar Juli/)).toBeInTheDocument();
    expect(screen.queryByText(/Bucht unwiderruflich/)).not.toBeInTheDocument();
    const strip = screen.getByRole('group', { name: 'Buchung beanstandet' });
    expect(within(strip).getByRole('button', { name: 'Buchung öffnen' })).toBeInTheDocument();
    fireEvent.click(within(strip).getByRole('button', { name: 'Als geprüft freigeben' }));
    expect(await screen.findByText('Markierung erledigt, Buchung freigegeben.')).toBeInTheDocument();
    const sent = calls.filter((c) => c.action === 'approve_entry');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toEqual({ workspaceId: 'ws_test', entryId: 'e1', idempotencyKey: 'attention:resolve:ws_test:e1:rev_1' });
  });

  it('names the agent seat and the Studio seat in words, and prints no id for an actor the engine cannot place', async () => {
    renderHub({
      attention_summary: ok(summaryOf([
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
      { attention_summary: ok(summaryOf([flagItem('e1')])) },
      { whoami: { actor: 'member:user_3', provisioned: true, isMember: true, memberId: 'm3', userId: 'user_3', role: 'treuhaender', capabilities: ['review'] } },
    );
    expect(await screen.findByText('Von dir markiert: Falsches Konto: Aufwand statt Ertrag')).toBeInTheDocument();
  });

  it('the link opens the Journal with the entry named', async () => {
    renderHub({ attention_summary: ok(summaryOf([flagItem('e1')])) });
    await screen.findByText('Buchung beanstandet');
    fireEvent.click(screen.getByRole('button', { name: 'Buchung öffnen' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/journal?entryId=e1'));
  });
});

describe('the dunning run row', () => {
  it('names the run, renders the dun sentence beside its own commit, and "Mahnlauf ausstellen" sends issue_dunning_run confirmed under the engine key', async () => {
    const { calls } = renderHub({ attention_summary: shrinkingSummary([dunningItem('run_1')]), issue_dunning_run: ok({ runId: 'run_1', status: 'issued' }) });
    expect(await screen.findByText('Mahnlauf wartet auf Freigabe')).toBeInTheDocument();
    expect(screen.getByText('3 Rechnungen, Vorschlag vom 2026-09-01')).toBeInTheDocument();
    expect(screen.getByText('Löst den Mahnlauf aus und erhöht die Mahnstufe der Debitoren.')).toBeInTheDocument();
    expect(screen.queryByText('issue_dunning_run')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mahnlauf ausstellen' }));
    expect(await screen.findByText('Mahnlauf ausgestellt.')).toBeInTheDocument();
    const sent = calls.filter((c) => c.action === 'issue_dunning_run');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toEqual({ workspaceId: 'ws_test', runId: 'run_1', idempotencyKey: 'attention:issue:ws_test:run_1', confirmed: true });
    expect(screen.getByTestId('where')).toHaveTextContent('/attention');
  });

  it('an actor without dun sees no issue control (hidden, never refused); the link into the run stays', async () => {
    renderHub({ attention_summary: ok(summaryOf([dunningItem('run_1')])) }, { can: (cap) => cap !== 'dun' });
    await screen.findByText('Mahnlauf wartet auf Freigabe');
    expect(screen.queryByRole('button', { name: 'Mahnlauf ausstellen' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mahnlauf öffnen' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/dunning?runId=run_1'));
  });
});

describe('accessibility', () => {
  it('has no axe violations with decision strips rendered', async () => {
    const { container } = renderHub({
      attention_summary: ok(summaryOf([draftItem('a1'), creditItem('c1'), flagItem('e1')], 3)),
      notifications_list: ok({ items: [], unreadCount: 0 }),
    });
    await screen.findByText('Zahlung ohne Zuordnung');
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});
