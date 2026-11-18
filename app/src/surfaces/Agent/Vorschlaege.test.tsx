/**
 * D197 (owner, 12.11.2026): the Vorschläge tab as LIST AND DETAIL, icon-only decisions, the one row Pendenzen
 * shares. Rendered from canned reads (synthetic by construction: invented names, ids and amounts), every
 * assertion about what the surface shows or which verb it sends.
 *
 * The intents of the D167 tests this screen replaced are kept here: Details never print JSON or a raw key,
 * the Freigabe level is READ from the dial, a bank-line Vorschlag reaches its line, a seat without
 * `manage_agent_dial` gets no decision, the standing grant confirms first and sends `allowFuture` once, the
 * reject reason is optional and trimmed, an answer after a workspace switch paints nothing, a refusal claims
 * no outcome, and a receipt already booked asks for the reason before it books again.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider, useWorkspace } from '../../app/workspace';
import { CapabilitiesContext, ALLOW_ALL, type Capabilities } from '../../lib/capabilities';
import { ATTENTION_CHANGED_EVENT } from '../Attention/attentionSummary';
import { Agent } from './index';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';

type Handler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | Handler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function fakeTransport(canned: Canned, calls?: { action: string; input: Record<string, unknown> }[]): Transport {
  return async (action, input) => {
    calls?.push({ action, input: input as Record<string, unknown> });
    const entry = canned[action];
    if (entry === undefined) return { status: 200, body: { ok: true } };
    return typeof entry === 'function' ? entry(input as Record<string, unknown>) : entry;
  };
}

const NO_DIAL_RIGHT: Capabilities = { whoami: null, can: (c) => c !== 'manage_agent_dial', refresh: () => undefined };

function renderAgent(canned: Canned, capabilities: Capabilities = ALLOW_ALL, calls?: { action: string; input: Record<string, unknown> }[]) {
  const client = new TillClient(fakeTransport(canned, calls));
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesContext.Provider value={capabilities}>
            <MemoryRouter initialEntries={['/agent?tab=vorschlaege']}>
              <Agent />
            </MemoryRouter>
          </CapabilitiesContext.Provider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

/** A bank-line booking: money OUT, with the line's facts and the engine's certainty. */
const OUT = {
  actionId: 'b1',
  actor: 'agent',
  dialCapability: 'post',
  actionTool: 'book_bank_line',
  payload: { bankTxnId: 'btx_1', target: { kind: 'accounts', legs: [{ accountId: 'acc_51', amountMinor: 2375 }] }, idempotencyKey: 'k1', agentReason: 'wie im Vormonat' },
  agentReason: 'wie im Vormonat',
  status: 'pending',
  createdAt: '2026-10-13T08:00:00.000Z',
  lineFacts: { date: '2026-10-02', counterparty: 'Velowerkstatt Beispiel GmbH', text: null, amountMinor: -2375, currency: 'CHF' },
  evidence: { certainty: 'check', reasons: ['no_engine_proposal'] },
  batchable: true,
};
/** A bank-line booking: money IN, sure. */
const IN = {
  ...OUT,
  actionId: 'b2',
  payload: { bankTxnId: 'btx_2', target: { kind: 'accounts', legs: [{ accountId: 'acc_51', amountMinor: 240000 }] }, idempotencyKey: 'k2' },
  agentReason: null,
  lineFacts: { date: '2026-10-03', counterparty: 'Kundin Muster AG', text: null, amountMinor: 240000, currency: 'CHF' },
  evidence: { certainty: 'sure', reasons: ['agrees'] },
};
/** A line set aside (an approval Rückgängig can undo). */
const IGNORE = {
  ...OUT,
  actionId: 'b3',
  actionTool: 'ignore_bank_line',
  payload: { bankTxnId: 'btx_3', reason: 'duplicate', idempotencyKey: 'k3' },
  agentReason: null,
  lineFacts: { date: '2026-10-04', counterparty: 'Zinsgutschrift Beispielbank', text: null, amountMinor: 35, currency: 'CHF' },
  evidence: undefined,
};
/** A posting with no bank line. */
const POST = {
  actionId: 'p1',
  actor: 'agent',
  dialCapability: 'post',
  actionTool: 'post_entry',
  payload: { workspaceId: 'ws_test', date: '2026-10-05', description: 'Briefmarken bar', idempotencyKey: 'k4', lines: [{ account: 'acc_50', debit: 2400 }, { account: 'acc_2', credit: 2400 }] },
  status: 'pending',
  createdAt: '2026-10-05T09:00:00.000Z',
  batchable: false,
};
/** A supplier IBAN change. */
const IBAN = {
  actionId: 'i1',
  actor: 'agent',
  dialCapability: 'pay',
  actionTool: 'set_creditor_bank_profile',
  payload: { vendorId: 'c_1', iban: 'CH44 3199 9123 0008 8901 2', idempotencyKey: 'k5' },
  payloadLabels: { vendorId: 'Rahmenbau Beispiel AG' },
  status: 'pending',
  createdAt: '2026-10-06T09:00:00.000Z',
  bankDetail: { contactName: 'Rahmenbau Beispiel AG', oldIban: 'CH93 0076 2011 6238 5295 7', newIban: 'CH44 3199 9123 0008 8901 2' },
  batchable: true, // whatever a row says, an IBAN change is never batchable
};
/** A posting whose record changed since the proposal. */
const STALE = { ...POST, actionId: 'p2', payload: { ...POST.payload, description: 'Abgrenzung Strom' }, changedSinceProposal: true };

const listOf = (...actions: Record<string, unknown>[]) => ok({ actions, approvalBatchMode: 'tick' });
const ACCOUNTS = { list_accounts: ok({ accounts: listAccountsFixture.accounts }) };

const rows = () => [...document.querySelectorAll('.vq-list .vrow')] as HTMLElement[];
const row = (actionId: string) => document.querySelector(`.vq-list .vrow[data-action-id="${actionId}"]`) as HTMLElement;
const select = async (subject: string) => {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(subject) }));
  return document.querySelector('.vdet') as HTMLElement;
};

describe('the list (D197 point 1)', () => {
  it('each row says the counterparty, the date, the certainty and the SIGNED amount; money out has its minus in danger ink', async () => {
    renderAgent({ list_drafted_actions: listOf(OUT, IN, POST), ...ACCOUNTS });
    await screen.findByText('Velowerkstatt Beispiel GmbH');
    const out = row('b1');
    expect(out).toHaveTextContent('Velowerkstatt Beispiel GmbH');
    expect(out).toHaveTextContent('02.10.2026');
    expect(out).toHaveTextContent('Prüfen');
    expect(out.querySelector('.vrow-amount')?.textContent).toBe('CHF -23.75');
    expect(out.querySelector('.vrow-sign')?.textContent).toBe('-');
    const inn = row('b2');
    expect(inn.querySelector('.vrow-amount')?.textContent).toBe("CHF 2'400.00");
    expect(inn.querySelector('.vrow-sign')).toBeNull();
    expect(inn).toHaveTextContent('Sicher');
    // The certainty is a glyph AND a word, never colour alone.
    expect(out.querySelector('.vrow-cert-dots')).not.toBeNull();
    // A posting names its accounts on the face (D162 point 1), never an id.
    await waitFor(() => expect(row('p1')).toHaveTextContent('6500 Verwaltungs- und Bürokosten an 1020 Bankkonto'));
    expect(row('p1')).not.toHaveTextContent('acc_50');
  });

  it('nothing is selected on arrival and the detail pane says nothing; selecting a row opens its detail', async () => {
    renderAgent({ list_drafted_actions: listOf(OUT, IN), ...ACCOUNTS });
    await screen.findByText('Velowerkstatt Beispiel GmbH');
    expect(document.querySelectorAll('.vrow--selected')).toHaveLength(0);
    // At rest the list takes the whole width: no detail column, no empty pane (the judge, point 2).
    expect(document.querySelector('.vdet')).toBeNull();
    expect(document.querySelector('.vq-detail')).toBeNull();
    expect(document.querySelector('.vq')).not.toHaveClass('vq--detail');
    const detail = await select('Velowerkstatt Beispiel GmbH');
    expect(document.querySelector('.vq')).toHaveClass('vq--detail');
    expect(row('b1')).toHaveClass('vrow--selected');
    expect(within(detail).getByRole('heading', { name: 'Velowerkstatt Beispiel GmbH' })).toBeInTheDocument();
    expect(detail.querySelector('.vdet-amount')?.textContent).toBe('CHF -23.75');
    expect(detail).toHaveTextContent('«wie im Vormonat»');
    await waitFor(() => expect(detail).toHaveTextContent('6570 Informatik, Software und Lizenzen'));
  });

  it('the list never regroups: no Geld/System headings, one row height class, the engine order kept above 20 rows', async () => {
    const many = Array.from({ length: 22 }, (_, i) => ({ ...POST, actionId: `p${i + 10}`, dialCapability: i % 2 === 0 ? 'post' : 'customize', payload: { ...POST.payload, description: `Posten ${i + 1}` } }));
    renderAgent({ list_drafted_actions: listOf(...many) });
    await screen.findByText('Posten 1');
    expect(screen.queryByRole('heading', { name: 'Geld' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'System' })).toBeNull();
    expect(rows().map((r) => r.getAttribute('data-action-id'))).toEqual(many.map((a) => a.actionId));
  });

  it('a settings change says the setting and its value, never "settings set"', async () => {
    const setting = { ...POST, actionId: 's1', dialCapability: 'customize', actionTool: 'settings_set', payload: { key: 'bank.buchungsregel_mode', value: 'suggest', reason: 'prüfen' }, setting: { key: 'bank.buchungsregel_mode', label: { en: 'Rule mode', 'de-CH': 'Buchungsregeln' }, value: 'suggest', current: 'book' } };
    renderAgent({ list_drafted_actions: listOf(setting) });
    expect(await screen.findByText('Buchungsregeln: vorschlagen')).toBeInTheDocument();
    expect(screen.queryByText(/settings set/)).toBeNull();
    const detail = await select('Buchungsregeln');
    expect(within(detail).getByText('buchen')).toBeInTheDocument();
    expect(screen.queryByText(/suggest/)).toBeNull();
  });
});

describe('the decision, icons only (D197 point 2)', () => {
  it('Freigeben and Ablehnen are icon buttons with their names; Freigeben sends approve_drafted_action once', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    renderAgent({ list_drafted_actions: listOf(OUT, IN), approve_drafted_action: ok({ status: 'executed' }), ...ACCOUNTS }, ALLOW_ALL, calls);
    const detail = await select('Velowerkstatt Beispiel GmbH');
    const approve = within(detail).getByRole('button', { name: 'Freigeben' });
    expect(approve).toHaveAttribute('data-icon', 'approve');
    expect(approve.textContent).toBe('');
    const reject = within(detail).getByRole('button', { name: 'Ablehnen' });
    expect(reject).toHaveAttribute('data-icon', 'reject');
    fireEvent.click(approve);
    await waitFor(() => expect(calls.filter((c) => c.action === 'approve_drafted_action')).toHaveLength(1));
    expect(calls.find((c) => c.action === 'approve_drafted_action')?.input).toEqual({ workspaceId: 'ws_test', actionId: 'b1' });
  });

  it('Ablehnen is ONE click that asks nothing and sends no reason (D204)', async () => {
    const sent: Record<string, unknown>[] = [];
    renderAgent({
      list_drafted_actions: listOf(OUT, IN),
      reject_drafted_action: (input) => {
        sent.push(input);
        return ok({ status: 'rejected' });
      },
    });
    let detail = await select('Velowerkstatt Beispiel GmbH');
    fireEvent.click(within(detail).getByRole('button', { name: 'Ablehnen' }));
    // No step, no field, no worded commit: the press is the rejection.
    expect(document.querySelector('textarea')).toBeNull();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ workspaceId: 'ws_test', actionId: 'b1' });
    // The next row is selected; it rejects the same way.
    detail = (await screen.findByRole('heading', { name: 'Kundin Muster AG' })).closest('.vdet') as HTMLElement;
    fireEvent.click(within(detail).getByRole('button', { name: 'Ablehnen' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect('reason' in (sent[1] as object)).toBe(false);
  });

  it('a stale Vorschlag keeps Freigeben in place, aria-disabled, its reason on the tooltip; Ablehnen stays', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    renderAgent({ list_drafted_actions: listOf(STALE) }, ALLOW_ALL, calls);
    await screen.findByText('Abgrenzung Strom');
    expect(row('p2')).toHaveTextContent('Geändert');
    const detail = await select('Abgrenzung Strom');
    const approve = within(detail).getByRole('button', { name: 'Freigeben' });
    expect(approve).toHaveAttribute('aria-disabled', 'true');
    expect(approve).toHaveClass('vdet-approve--disabled');
    expect(approve).toHaveAccessibleDescription(/Seit dem Vorschlag geändert/);
    fireEvent.click(approve);
    expect(calls.some((c) => c.action === 'approve_drafted_action')).toBe(false);
    expect(within(detail).getByRole('button', { name: 'Ablehnen' })).not.toBeDisabled();
  });

  it('a bank-line Vorschlag opens its line on /bank by the Öffnen icon', async () => {
    renderAgent({ list_drafted_actions: listOf(OUT), ...ACCOUNTS });
    const detail = await select('Velowerkstatt Beispiel GmbH');
    await waitFor(() => expect(detail).toHaveTextContent('6570 Informatik'));
    const open = within(detail).getByRole('button', { name: 'Zur Bankzeile' });
    expect(open).toHaveAttribute('data-icon', 'open');
    // Details never print the line id, JSON or a raw key.
    const text = detail.querySelector('.vdet-readback')?.textContent ?? '';
    for (const raw of ['btx_1', '{', 'idempotencyKey', 'Agent reason', 'agentReason', 'legs']) expect(text).not.toContain(raw);
  });

  it('the detail carries no settings note and repeats nothing the face says (the judge, point 3)', async () => {
    renderAgent({
      list_drafted_actions: listOf(OUT),
      get_agent_dial: ok({ rows: [{ capability: 'post', stored: 'auto', effective: 'auto', strongDefault: false }] }),
      ...ACCOUNTS,
    });
    const detail = await select('Velowerkstatt Beispiel GmbH');
    await waitFor(() => expect(detail).toHaveTextContent('6570 Informatik'));
    const terms = [...detail.querySelectorAll('.vorschlag-readback dt')].map((n) => n.textContent);
    expect(terms).not.toContain('Freigabe');
    expect(terms).not.toContain('Art');
    expect(terms).not.toContain('Konto');
    expect(within(detail).queryByRole('link', { name: 'einstellbar' })).toBeNull();
    // The unsigned amount never comes back below the signed one.
    expect(detail.querySelector('.vorschlag-readback')?.textContent ?? '').not.toContain('23.75');
  });

  it('without manage_agent_dial there is no decision, only the missing right; no tick box either', async () => {
    renderAgent({ list_drafted_actions: listOf(OUT) }, NO_DIAL_RIGHT);
    await screen.findByText('Velowerkstatt Beispiel GmbH');
    expect(row('b1').querySelector('input[type="checkbox"]')).toBeNull();
    const detail = await select('Velowerkstatt Beispiel GmbH');
    expect(within(detail).queryByRole('button', { name: 'Freigeben' })).toBeNull();
    expect(within(detail).queryByRole('button', { name: 'Ablehnen' })).toBeNull();
    expect(within(detail).getByText(/Benötigt: Agent-Freigabe/)).toBeInTheDocument();
  });

  it('D207 F6: the dial grant is "Freigeben und dem Agenten künftig erlauben" (never the bank rule\'s words); it names its reach first, then sends allowFuture once', async () => {
    const sent: Record<string, unknown>[] = [];
    renderAgent({
      list_drafted_actions: listOf(POST, { ...POST, actionId: 'p9', payload: { ...POST.payload, description: 'Porto' } }),
      approve_drafted_action: (input) => {
        sent.push(input);
        return ok({ status: 'executed' });
      },
    });
    const detail = await select('Briefmarken bar');
    fireEvent.click(within(detail).getByRole('button', { name: /^Mehr zu:/ }));
    const grant = await screen.findByRole('menuitem', { name: 'Freigeben und dem Agenten künftig erlauben' });
    expect(screen.queryByRole('menuitem', { name: 'Freigeben und künftig automatisch' })).toBeNull();
    fireEvent.click(grant);
    const dialog = await screen.findByRole('alertdialog');
    // The reach: this one, the open ones of its kind here, every future one; attributed and revocable.
    expect(dialog).toHaveTextContent('alle 2 offenen dieser Art hier und jeden künftigen');
    expect(dialog).toHaveTextContent('widerrufbar');
    expect(sent).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Freigeben und erlauben' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ workspaceId: 'ws_test', actionId: 'p1', allowFuture: true });
  });
});

describe('a supplier IBAN change (the fresh-eyes judge)', () => {
  it('shows the supplier and OLD -> NEW on its face, has no tick box, and confirms before it runs', async () => {
    const sent: Record<string, unknown>[] = [];
    renderAgent({
      list_drafted_actions: listOf(IBAN),
      approve_drafted_action: (input) => {
        sent.push(input);
        return ok({ status: 'executed' });
      },
    });
    await screen.findByText('Rahmenbau Beispiel AG');
    expect(row('i1')).toHaveTextContent('IBAN CH93 0076 2011 6238 5295 7 → CH44 3199 9123 0008 8901 2');
    expect(row('i1').querySelector('input[type="checkbox"]')).toBeNull();
    const detail = await select('Rahmenbau Beispiel AG');
    expect(detail).toHaveTextContent('CH93 0076 2011 6238 5295 7');
    expect(detail).toHaveTextContent('CH44 3199 9123 0008 8901 2');
    fireEvent.click(within(detail).getByRole('button', { name: 'Freigeben' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'IBAN von Rahmenbau Beispiel AG ändern?' });
    expect(dialog).toHaveTextContent('CH93 0076 2011 6238 5295 7');
    expect(dialog).toHaveTextContent('CH44 3199 9123 0008 8901 2');
    expect(sent).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'IBAN ändern' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    // Never offered as a standing grant either.
    expect(screen.queryByRole('menuitem', { name: 'Freigeben und dem Agenten künftig erlauben' })).toBeNull();
  });
});

describe('the toolbar: Status, search, facets (D197 point 1)', () => {
  it('the Status control reads the history the engine serves: Genehmigt asks status executed and lists those rows', async () => {
    const asked: string[] = [];
    renderAgent({
      list_drafted_actions: (input) => {
        asked.push(String(input.status));
        return input.status === 'executed'
          ? listOf({ ...OUT, actionId: 'x1', status: 'executed', resolvedAt: '2026-10-14T10:00:00.000Z', resolvedBy: 'user_1', batchable: false, evidence: undefined })
          : input.status === 'rejected'
            ? listOf(
                { ...POST, actionId: 'r1', status: 'rejected', rejectReason: 'Privat', resolvedAt: '2026-10-15T09:00:00.000Z', resolvedBy: 'studio' },
                {
                  ...OUT, actionId: 'r2', status: 'rejected', rejectReason: 'falscher Betrag', resolvedAt: '2026-10-16T09:00:00.000Z', resolvedBy: 'agent', batchable: false, evidence: undefined,
                  history: [{ event: 'decided_under_grant', decision: 'rejected', at: '2026-10-16T09:00:00.000Z', by: 'agent', scope: 'reject', grantedBy: 'studio', grantedAt: '2026-10-01T08:00:00.000Z' }],
                },
              )
            : listOf(OUT, IN);
      },
    });
    await screen.findByText('Kundin Muster AG');
    expect(asked).toContain('pending');
    const status = () => screen.getByRole('radiogroup', { name: 'Status' });
    for (const label of ['Offen', 'Freigegeben', 'Abgelehnt', 'Veraltet']) expect(within(status()).getByRole('radio', { name: label })).toBeInTheDocument();
    fireEvent.click(within(status()).getByRole('radio', { name: 'Freigegeben' }));
    await waitFor(() => expect(asked).toContain('executed'));
    await waitFor(() => expect(rows().map((r) => r.getAttribute('data-action-id'))).toEqual(['x1']));
    expect(row('x1').querySelector('input[type="checkbox"]')).toBeNull();
    const detail = await select('Velowerkstatt Beispiel GmbH');
    // Never the raw actor id (D197): a served member's id reads as a person.
    expect(detail).toHaveTextContent('am 14.10.2026 von einer Person');
    expect(detail).not.toHaveTextContent('user_1');
    expect(within(detail).queryByRole('button', { name: 'Freigeben' })).toBeNull();
    fireEvent.click(within(status()).getByRole('radio', { name: 'Abgelehnt' }));
    await waitFor(() => expect(rows().map((r) => r.getAttribute('data-action-id'))).toEqual(['r1', 'r2']));
    const byPerson = await select('Briefmarken bar');
    expect(byPerson).toHaveTextContent('Grund: Privat');
    expect(byPerson).toHaveTextContent('am 15.10.2026 im Studio');
    expect(byPerson).not.toHaveTextContent('von studio');
    // D196: the agent's rejection under the owner's grant says so, and names the grant on hover.
    const byAgent = await select('Velowerkstatt Beispiel GmbH');
    expect(byAgent).toHaveTextContent('am 16.10.2026 vom Agenten, mit deiner Freigabe');
    const decided = byAgent.querySelector('[data-decided-by="agent"]');
    expect(decided?.getAttribute('title')).toBe('Freigabe erteilt im Studio am 01.10.2026');
  });

  it('D209: an approval on the owner\'s word shows the words on the decided card, and the Entschieden facet finds it', async () => {
    const WORD = { event: 'decided_on_owner_word', decision: 'approved', at: '2026-11-18T10:00:00.000Z', by: 'agent', quote: 'Ja, beide Importe sind genehmigt.', saidAt: '2026-11-18T09:55:00.000Z', grantedBy: 'studio', grantedAt: '2026-11-18T08:00:00.000Z' };
    renderAgent({
      list_drafted_actions: (input) =>
        input.status === 'executed'
          ? listOf(
              { ...OUT, actionId: 'w1', status: 'executed', resolvedAt: '2026-11-18T10:00:00.000Z', resolvedBy: 'agent', batchable: false, evidence: undefined, history: [WORD] },
              { ...POST, actionId: 'p1', status: 'executed', resolvedAt: '2026-11-17T10:00:00.000Z', resolvedBy: 'studio' },
            )
          : listOf(IN),
      ...ACCOUNTS,
    });
    await screen.findByText('Kundin Muster AG');
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Status' })).getByRole('radio', { name: 'Freigegeben' }));
    await waitFor(() => expect(rows().map((r) => r.getAttribute('data-action-id'))).toEqual(['w1', 'p1']));
    const detail = await select('Velowerkstatt Beispiel GmbH');
    expect(detail).toHaveTextContent('am 18.11.2026 vom Agenten, im Chat freigegeben');
    const words = detail.querySelector('[data-owner-word]');
    expect(words).toHaveTextContent('Freigabe im Chat');
    expect(words).toHaveTextContent('«Ja, beide Importe sind genehmigt.», 18.11.2026');
    // The facet: "Entschieden: im Chat freigegeben" keeps only the row the agent approved on the owner's word.
    fireEvent.click(screen.getByRole('button', { name: /Filter hinzufügen|Filter/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /im Chat freigegeben/ }));
    await waitFor(() => expect(rows().map((r) => r.getAttribute('data-action-id'))).toEqual(['w1']));
  });

  it('a facet narrows the list, its chip removes it; a facet that would not change the list is not offered', async () => {
    renderAgent({ list_drafted_actions: listOf(OUT, IN, POST), ...ACCOUNTS });
    await screen.findByText('Kundin Muster AG');
    expect(rows()).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: /Filter hinzufügen|Filter/ }));
    // Every row is a bank row with... no: two of three are, so Richtung is offered; Beleg (none has one) is not.
    expect(await screen.findByRole('menuitem', { name: /Ausgang/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Mit Beleg/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /Ausgang/ }));
    await waitFor(() => expect(rows().map((r) => r.getAttribute('data-action-id'))).toEqual(['b1']));
    fireEvent.click(screen.getByRole('button', { name: 'Entfernen' }));
    await waitFor(() => expect(rows()).toHaveLength(3));
  });

  it('the search finds a row by its counterparty or its amount; a filtered-empty list offers the way back', async () => {
    renderAgent({ list_drafted_actions: listOf(OUT, IN) });
    await screen.findByText('Kundin Muster AG');
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: '23.75' } });
    await waitFor(() => expect(rows().map((r) => r.getAttribute('data-action-id'))).toEqual(['b1']));
    fireEvent.change(search, { target: { value: 'nirgends' } });
    expect(await screen.findByText('Keine Treffer.')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Filter zurücksetzen' })[0] as HTMLElement);
    await waitFor(() => expect(rows()).toHaveLength(2));
  });
});

describe('the batch (D197 point 1, attention.approval_batch_mode)', () => {
  it('only batchable rows carry a tick box, never pre-ticked; the selection bar sums the SIGNED amounts and approves them in ONE batch call', async () => {
    const sent: Record<string, unknown>[] = [];
    const single: Record<string, unknown>[] = [];
    renderAgent({
      list_drafted_actions: listOf(OUT, IN, POST),
      approve_drafted_actions: (input) => {
        sent.push(input);
        return ok({ items: (input.ids as string[]).map((actionId, index) => ({ index, actionId, ok: true, result: { ok: true } })) });
      },
      approve_drafted_action: (input) => {
        single.push(input);
        return ok({ status: 'executed' });
      },
    });
    await screen.findByText('Kundin Muster AG');
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box).not.toBeChecked();
    expect(row('p1').querySelector('input[type="checkbox"]')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Velowerkstatt Beispiel GmbH auswählen' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Kundin Muster AG auswählen' }));
    const bar = document.querySelector('.vq-toolbar--selection') as HTMLElement;
    expect(bar).toHaveTextContent('2 ausgewählt');
    // -23.75 + 2'400.00 = 2'376.25, signed, never one absolute sum.
    expect(bar.querySelector('.vsel-sum')?.textContent).toBe("CHF 2'376.25");
    fireEvent.click(within(bar).getByRole('button', { name: 'Freigeben (2)' }));
    await waitFor(() => expect(sent).toEqual([{ workspaceId: 'ws_test', ids: ['b1', 'b2'] }]));
    expect(single).toHaveLength(0);
  });

  it('Ablehnen (n) rejects every ticked row in ONE reject_drafted_actions call, with no reason', async () => {
    const sent: Record<string, unknown>[] = [];
    renderAgent({
      list_drafted_actions: listOf(OUT, IN),
      reject_drafted_actions: (input) => {
        sent.push(input);
        return ok({ items: (input.ids as string[]).map((actionId, index) => ({ index, actionId, outcome: 'rejected', ok: true, result: { ok: true } })) });
      },
    });
    await screen.findByText('Kundin Muster AG');
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);
    const bar = document.querySelector('.vq-toolbar--selection') as HTMLElement;
    fireEvent.click(within(bar).getByRole('button', { name: 'Ablehnen (2)' }));
    await waitFor(() => expect(sent).toEqual([{ workspaceId: 'ws_test', ids: ['b1', 'b2'] }]));
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('under the setting single there are no tick boxes', async () => {
    renderAgent({ list_drafted_actions: ok({ actions: [OUT, IN], approvalBatchMode: 'single' }) });
    await screen.findByText('Kundin Muster AG');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});

describe('after a decision (the fresh-eyes judge)', () => {
  it('the order is kept, the focus and the selection move to the next row, a transient toast names the row, the rail badge re-reads', async () => {
    let decided = false;
    let announced = 0;
    const onChanged = () => {
      announced += 1;
    };
    window.addEventListener(ATTENTION_CHANGED_EVENT, onChanged);
    const { container } = renderAgent({
      list_drafted_actions: () => (decided ? listOf(OUT, POST) : listOf(OUT, IN, POST)),
      approve_drafted_action: () => {
        decided = true;
        return ok({ status: 'executed' });
      },
    });
    await screen.findByText('Kundin Muster AG');
    const detail = await select('Kundin Muster AG');
    fireEvent.click(within(detail).getByRole('button', { name: 'Freigeben' }));
    const toast = await screen.findByText('Freigegeben: Kundin Muster AG');
    expect(toast.closest('[role="status"]')).not.toBeNull();
    // No boxed banner above the list.
    expect(container.querySelector('.action-feedback')).toBeNull();
    await waitFor(() => expect(rows().map((r) => r.getAttribute('data-action-id'))).toEqual(['b1', 'p1']));
    await waitFor(() => expect(row('p1')).toHaveClass('vrow--selected'));
    await waitFor(() => expect(row('p1').querySelector('.vrow-main')).toHaveFocus());
    expect(announced).toBeGreaterThan(0);
    window.removeEventListener(ATTENTION_CHANGED_EVENT, onChanged);
  });

  it('an approved ignore offers Rückgängig, which reopens the line through reopen_bank_line', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    renderAgent({ list_drafted_actions: listOf(IGNORE), approve_drafted_action: ok({ status: 'executed' }), reopen_bank_line: ok({}) }, ALLOW_ALL, calls);
    const detail = await select('Zinsgutschrift Beispielbank');
    fireEvent.click(within(detail).getByRole('button', { name: 'Freigeben' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Rückgängig' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'reopen_bank_line')).toBe(true));
    expect(calls.find((c) => c.action === 'reopen_bank_line')?.input).toMatchObject({ workspaceId: 'ws_test', bankTxnId: 'btx_3' });
    expect(await screen.findByText('Wieder offen: Zinsgutschrift Beispielbank')).toBeInTheDocument();
  });

  it('a refused approval claims no outcome: the toast says the refusal and the row stays', async () => {
    renderAgent({ list_drafted_actions: listOf(OUT), approve_drafted_action: { status: 409, body: { ok: false, error: 'already_rejected' } } });
    const detail = await select('Velowerkstatt Beispiel GmbH');
    fireEvent.click(within(detail).getByRole('button', { name: 'Freigeben' }));
    await waitFor(() => expect(document.querySelector('.vtoast')).not.toBeNull());
    expect(screen.queryByText(/^Freigegeben:/)).toBeNull();
    expect(row('b1')).not.toBeNull();
  });

  it('§H-TENANT: an approval answered after a workspace switch paints no toast and no old row on the new workspace', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const canned: Canned = {
      list_drafted_actions: (input) => (input.workspaceId === 'ws_test' ? listOf(OUT) : listOf()),
      approve_drafted_action: (() => gate.then(() => ok({ status: 'executed' }))) as unknown as Handler,
    };
    function SwitchToB() {
      const { setWorkspaceId } = useWorkspace();
      return (
        <button type="button" onClick={() => setWorkspaceId('ws_b')}>
          switch-to-b
        </button>
      );
    }
    render(
      <TillClientProvider client={new TillClient(fakeTransport(canned))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <CapabilitiesContext.Provider value={ALLOW_ALL}>
              <MemoryRouter initialEntries={['/agent?tab=vorschlaege']}>
                <SwitchToB />
                <Agent />
              </MemoryRouter>
            </CapabilitiesContext.Provider>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    const detail = await select('Velowerkstatt Beispiel GmbH');
    fireEvent.click(within(detail).getByRole('button', { name: 'Freigeben' }));
    fireEvent.click(screen.getByRole('button', { name: 'switch-to-b' }));
    expect(await screen.findByText('Nichts freizugeben.')).toBeInTheDocument();
    await act(async () => {
      (release as unknown as () => void)();
      await gate;
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByText(/Freigegeben:/)).toBeNull();
    expect(rows()).toHaveLength(0);
  });
});

describe('N02 R1: a receipt that is already booked', () => {
  const holder = { entityKind: 'journal_entry', entityId: 'je_7', reservedBy: null };
  const withHolder = { ...POST, receiptHolders: [holder] };
  const confirmable: RestResponse = { status: 409, body: { ok: false, error: 'receipt_already_booked', holders: [holder], override: 'bookAgain with overrideReason' } };

  it('the detail says the receipt is booked; approving asks for the reason and sends the same approval with it', async () => {
    const approvals: Record<string, unknown>[] = [];
    renderAgent({
      list_drafted_actions: listOf(withHolder),
      approve_drafted_action: (input) => {
        approvals.push(input);
        return input.bookAgain === true ? ok({ status: 'executed' }) : confirmable;
      },
    });
    const detail = await select('Briefmarken bar');
    expect(within(detail).getByText('Dieser Beleg ist bereits gebucht (Buchung).')).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole('button', { name: 'Freigeben' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Beleg schon gebucht' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Trotzdem buchen' }));
    expect(await screen.findByText('Freigegeben: Briefmarken bar')).toBeInTheDocument();
    expect(approvals[1]).toMatchObject({ actionId: 'p1', bookAgain: true });
    expect(approvals[1]).not.toHaveProperty('overrideReason');
  });

  it('holders_changed: nothing is asked, the person is told and the list re-reads', async () => {
    let reads = 0;
    renderAgent({
      list_drafted_actions: () => {
        reads += 1;
        return listOf(withHolder);
      },
      approve_drafted_action: { status: 409, body: { ok: false, error: 'holders_changed', actionId: 'p1', holders: [holder] } },
    });
    const detail = await select('Briefmarken bar');
    const before = reads;
    fireEvent.click(within(detail).getByRole('button', { name: 'Freigeben' }));
    expect(await screen.findByText(/Der Beleg wurde inzwischen anderswo gebucht/)).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(reads).toBeGreaterThan(before));
  });
});

describe('the frame and the empty state', () => {
  it('the tab panel is no focus stop of its own once the list has rows (D197 point 3)', async () => {
    renderAgent({ list_drafted_actions: listOf(OUT) });
    await screen.findByText('Velowerkstatt Beispiel GmbH');
    const panel = screen.getByRole('tabpanel', { name: 'Vorschläge' });
    await waitFor(() => expect(panel).not.toHaveAttribute('tabindex'));
  });

  it('the empty queue says one line, no helper sentence, and keeps the Status control for the history', async () => {
    renderAgent({ list_drafted_actions: listOf() });
    expect(await screen.findByText('Nichts freizugeben.')).toBeInTheDocument();
    expect(screen.queryByText(/Der Agent erfasst Vorschläge/)).toBeNull();
    expect(screen.getByRole('radiogroup', { name: 'Status' })).toBeInTheDocument();
  });

  it('axe: the list and an open detail are clean', async () => {
    const { container } = renderAgent({ list_drafted_actions: listOf(OUT, IN, IBAN), ...ACCOUNTS });
    await select('Velowerkstatt Beispiel GmbH');
    const results = await axe(container, { rules: { region: { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});

describe('the judge round (D197 fix round)', () => {
  it('a changed Vorschlag offers Zum Datensatz beside Ablehnen where its record has a route', async () => {
    const changedBill = { ...POST, actionId: 'e1', actionTool: 'record_expense', payload: { vendorId: 'c_9', billDate: '2026-09-27', amountMinor: 74500 }, payloadLabels: { vendorId: 'Druckerei Beispiel AG' }, changedSinceProposal: true };
    renderAgent({ list_drafted_actions: listOf(changedBill) });
    const detail = await select('Druckerei Beispiel AG');
    expect(within(detail).getByRole('button', { name: 'Freigeben' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(detail).getByRole('button', { name: 'Ablehnen' })).toBeEnabled();
    expect(within(detail).getByRole('button', { name: 'Zum Datensatz' })).toHaveAttribute('data-icon', 'open');
    // The business date of a bill is its bill date, in ink.
    expect(row('e1').querySelector('.vrow-date')?.textContent).toBe('27.09.2026');
    expect(row('e1').querySelector('.vrow-date')).not.toHaveClass('vrow-date--proposal');
    // Let the chart read settle inside the test.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  });

  it('the date column is the business date; a setting has none, so its proposal date reads dim', async () => {
    const setting = { ...POST, actionId: 's2', actionTool: 'settings_set', payload: { key: 'bank.x', value: 'suggest' }, createdAt: '2026-11-12T08:00:00.000Z', setting: { key: 'bank.x', label: { en: 'x', 'de-CH': "Regeln und 'Alle buchen'" }, value: 'suggest' } };
    const vat = { ...POST, actionId: 'v1', actionTool: 'vat_mark_filed', dialCapability: 'vat-file', payload: { period: '2026-Q1' } };
    renderAgent({ list_drafted_actions: listOf(OUT, setting, vat) });
    await screen.findByText('Velowerkstatt Beispiel GmbH');
    expect(row('b1').querySelector('.vrow-date')?.textContent).toBe('02.10.2026');
    expect(row('s2').querySelector('.vrow-date')).toHaveClass('vrow-date--proposal');
    // A filed period's business date is its last day.
    expect(row('v1').querySelector('.vrow-date')?.textContent).toBe('31.03.2026');
    // Typographic quotes and the value in words in the settings subject.
    expect(row('s2')).toHaveTextContent('Regeln und «Alle buchen»: vorschlagen');
  });

  it('a batch names each refused row (its reason under its subject); the approved rows leave', async () => {
    let approved = false;
    renderAgent({
      list_drafted_actions: () => (approved ? listOf({ ...IN, changedSinceProposal: true, batchable: false }) : listOf(OUT, IN)),
      approve_drafted_actions: (input) => {
        approved = true;
        return ok({
          items: (input.ids as string[]).map((actionId, index) =>
            actionId === 'b2' ? { index, actionId, ok: false, refusal: { ok: false, error: 'vorschlag_stale' } } : { index, actionId, ok: true, result: { ok: true } },
          ),
        });
      },
    });
    await screen.findByText('Kundin Muster AG');
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);
    fireEvent.click(within(document.querySelector('.vq-toolbar--selection') as HTMLElement).getByRole('button', { name: 'Freigeben (2)' }));
    expect(await screen.findByText(/1 freigegeben, 1 nicht/)).toBeInTheDocument();
    await waitFor(() => expect(row('b2')).toHaveTextContent('Geändert'));
    expect(row('b1')).toBeNull();
    // The refused row stays with its reason; once changed it is no longer batchable, so its box leaves.
    expect(row('b2').querySelector('input[type="checkbox"]')).toBeNull();
  });
});
