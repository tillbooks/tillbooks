/**
 * WHAT YOU APPROVED IS WHAT RUNS (critic N1) at the surface. The card used to show `invoiceId` and
 * nothing else for an `issue_invoice` Vorschlag, so the person could not see that the draft behind it
 * was CHF 99,999 rather than the CHF 1,000 the agent had talked about. The engine now freezes the
 * record's key figures at the proposal; these tests hold that the card leads with them, says when the
 * record changed since (and holds the approve), and that a `vorschlag_stale` refusal is named in words
 * on both decision surfaces instead of landing silently.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { I18nProvider } from '../../i18n';
import { CapabilitiesContext, ALLOW_ALL } from '../../lib/capabilities';
import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { WorkspaceProvider } from '../../app/workspace';
import { Agent } from './index';
import { VorschlagLine } from './VorschlagLine';
import { Turn } from './TurnList';
import { parseDrafted, type AgentTurn, type DraftedAction } from './model';

const quiet: Transport = async () => ({ status: 200, body: { ok: true } });

function wrap(node: React.ReactNode, transport: Transport = quiet) {
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesContext.Provider value={ALLOW_ALL}>
            <MemoryRouter initialEntries={['/agent']}>{node}</MemoryRouter>
          </CapabilitiesContext.Provider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

/** A synthetic issue_invoice Vorschlag on a draft: CHF 1,000.00 net, two lines, Muster AG. */
const issueDraft: DraftedAction = {
  actionId: 'act_1',
  actor: 'agent',
  dialCapability: 'issue',
  actionTool: 'issue_invoice',
  payload: { workspaceId: 'ws_test', invoiceId: 'doc_1', idempotencyKey: 'k1' },
  status: 'pending',
  createdAt: '2026-10-11T09:00:00.000Z',
  rejectReason: null,
  figures: {
    number: null,
    numberPending: true,
    counterparty: 'Muster AG',
    recipient: 'buchhaltung@muster.example',
    amountMinor: 100000,
    amountBasis: 'net',
    currency: 'CHF',
    taxMinor: 8100,
    grossMinor: 108100,
    lineCount: 2,
  },
  changedSinceProposal: false,
};

/** D167: the figures live in the line's Details disclosure, one click on the title. */
function openDetails() {
  fireEvent.click(document.querySelector('.vorschlag-line-title') as HTMLElement);
}

const rows = () =>
  [...document.querySelectorAll('.vorschlag-readback-row')].map((row) => [
    row.querySelector('dt')?.textContent ?? '',
    row.querySelector('dd')?.textContent ?? '',
  ]);

beforeEach(() => {
  window.localStorage.clear();
});

describe('D162 point 1 on the line\'s face: the essentials without opening Details', () => {
  const names = new Map([
    ['acc_6500', '6500 Büromaterial'],
    ['acc_1020', '1020 Bank'],
    ['acc_6570', '6570 Informatik'],
  ]);
  const face = () => document.querySelector('[data-figure="key"]')?.textContent;

  it('an issue: the pinned counterparty, the recipient and the total', () => {
    wrap(<VorschlagLine action={issueDraft} onApprove={() => undefined} onReject={() => undefined} />);
    expect(document.querySelector('.vorschlag-readback')).toBeNull();
    expect(face()).toBe("CHF 1'081.00 · Muster AG · an buchhaltung@muster.example");
  });

  it('a posting with two lines: debit an credit in words, and the total', () => {
    const post: DraftedAction = { ...issueDraft, actionId: 'act_p', actionTool: 'post_entry', dialCapability: 'post', figures: null, payload: { workspaceId: 'ws_test', date: '2026-10-10', lines: [{ account: 'acc_6500', debit: 4850 }, { account: 'acc_1020', credit: 4850 }] } };
    wrap(<VorschlagLine action={post} accountNames={names} onApprove={() => undefined} onReject={() => undefined} />);
    expect(document.querySelector('.vorschlag-readback')).toBeNull();
    expect(face()).toBe('CHF 48.50 · 6500 Büromaterial an 1020 Bank');
  });

  it('a posting with more lines says how many accounts; a bank booking says where it books', () => {
    const many: DraftedAction = { ...issueDraft, actionId: 'act_m', actionTool: 'post_entry', dialCapability: 'post', figures: null, payload: { lines: [{ account: 'acc_6500', debit: 4000 }, { account: 'acc_6570', debit: 850 }, { account: 'acc_1020', credit: 4850 }] } };
    const { unmount } = wrap(<VorschlagLine action={many} accountNames={names} onApprove={() => undefined} onReject={() => undefined} />);
    expect(face()).toBe('CHF 48.50 · 3 Konten');
    unmount();
    const bank: DraftedAction = { ...issueDraft, actionId: 'act_b', actionTool: 'book_bank_line', dialCapability: 'post', figures: null, payload: { bankTxnId: 'bt_1', target: { kind: 'accounts', legs: [{ accountId: 'acc_6570', amountMinor: 1654, taxCode: 'VST-I' }] } } };
    wrap(<VorschlagLine action={bank} accountNames={names} onApprove={() => undefined} onReject={() => undefined} />);
    expect(face()).toBe('CHF 16.54 · auf 6570 Informatik');
  });

  it('without the chart a posting still names its sides as "Konto", never an id', () => {
    const post: DraftedAction = { ...issueDraft, actionId: 'act_n', actionTool: 'post_entry', dialCapability: 'post', figures: null, payload: { lines: [{ account: 'acc_6500aaaa-0000-4000-8000-000000000001', debit: 4850 }, { account: 'acc_1020bbbb-0000-4000-8000-000000000002', credit: 4850 }] } };
    wrap(<VorschlagLine action={post} onApprove={() => undefined} onReject={() => undefined} />);
    expect(face()).toBe('CHF 48.50 · Konto an Konto');
  });
});

describe('the card shows what is being approved', () => {
  it('leads with the frozen figures: Netto with currency, draft number, counterparty, line count', () => {
    wrap(<VorschlagLine action={issueDraft} onApprove={() => undefined} onReject={() => undefined} />);
    openDetails();
    const shown = rows();
    expect(shown[0]?.[0]).toBe('Netto');
    expect(shown[0]?.[1]).toContain("1'000.00");
    expect(shown[0]?.[1]).toContain('CHF');
    expect(shown).toContainEqual(['Nummer', 'Entwurf, noch ohne Nummer']);
    expect(shown).toContainEqual(['Gegenpartei', 'Muster AG']);
    expect(shown).toContainEqual(['Positionen', '2']);
    // Critic round 2: the recipient the send goes to, and VAT and gross beside the net.
    expect(shown).toContainEqual(['An', 'buchhaltung@muster.example']);
    expect(shown.find(([term]) => term === 'MWST')?.[1]).toContain('81.00');
    expect(shown.find(([term]) => term === 'Total')?.[1]).toContain("1'081.00");
    // The figure is the lead: it is not repeated by the payload-derived amount row.
    expect(shown.filter(([, value]) => value.includes("1'000.00"))).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Genehmigen' })).toBeEnabled();
  });

  it('an issued number, a foreign currency and the plain amount label render as given', () => {
    const run: DraftedAction = {
      ...issueDraft,
      actionTool: 'payment_batch_transmit',
      figures: { number: 'R-2026-0007', numberPending: false, counterparty: null, recipient: null, amountMinor: 250050, amountBasis: 'amount', currency: 'EUR', taxMinor: null, grossMinor: null, lineCount: 3 },
    };
    wrap(<VorschlagLine action={run} onApprove={() => undefined} onReject={() => undefined} />);
    openDetails();
    const shown = rows();
    expect(shown[0]?.[0]).toBe('Betrag');
    expect(shown[0]?.[1]).toContain('EUR');
    expect(shown[0]?.[1]).toContain("2'500.50");
    expect(shown).toContainEqual(['Nummer', 'R-2026-0007']);
    expect(shown.some(([term]) => term === 'Gegenpartei')).toBe(false);
    expect(shown.some(([term]) => term === 'MWST' || term === 'An')).toBe(false);
  });

  it('a Vorschlag with no frozen figures keeps the payload read-back it always had', () => {
    const plain: DraftedAction = { ...issueDraft, actionTool: 'record_payment', figures: null, payload: { workspaceId: 'ws_test', amountMinor: 120000 } };
    wrap(<VorschlagLine action={plain} onApprove={() => undefined} onReject={() => undefined} />);
    openDetails();
    expect(rows()[0]?.[1]).toContain("1'200.00");
    expect(rows().some(([term]) => term === 'Nummer')).toBe(false);
  });

  it('when the record changed since the proposal the card says so and holds the approve', () => {
    const { container } = wrap(<VorschlagLine action={{ ...issueDraft, changedSinceProposal: true }} onApprove={() => undefined} onReject={() => undefined} />);
    // Critic N4 L4: on /agent the sentence is VISIBLE under the line at rest, not only in a tooltip (only
    // Pendenzen's compact line moves the explanation behind the (i)).
    const said = container.querySelector('.vorschlag-line-changed');
    expect(said).not.toBeNull();
    expect(said?.closest('[role="tooltip"]')).toBeNull();
    expect(said?.textContent).toContain('Seit dem Vorschlag geändert. Genehmigen würde nichts ausführen.');
    openDetails();
    expect(screen.getAllByText(/Seit dem Vorschlag geändert/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Genehmigen' })).toBeNull();
    // Rejecting stays possible, from the overflow.
    fireEvent.click(screen.getByRole('button', { name: 'Mehr zu: Rechnung ausstellen' }));
    expect(screen.queryByRole('menuitem', { name: 'Genehmigen und künftig automatisch' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Ablehnen' })).toBeEnabled();
  });

  it('parseDrafted reads the figures defensively: a malformed shape is absent, never guessed', () => {
    const [good, bad] = parseDrafted({
      actions: [
        { actionId: 'a', actionTool: 'issue_invoice', figures: { amountMinor: 5000, amountBasis: 'net', currency: 'CHF', numberPending: true }, changedSinceProposal: true },
        { actionId: 'b', actionTool: 'issue_invoice', figures: 'oops' },
      ],
    });
    expect(good?.figures?.amountMinor).toBe(5000);
    expect(good?.figures?.numberPending).toBe(true);
    expect(good?.figures?.counterparty).toBeNull();
    expect(good?.changedSinceProposal).toBe(true);
    expect(bad?.figures).toBeNull();
    expect(bad?.changedSinceProposal).toBe(false);
  });
});

describe('the stale refusal is named in words', () => {
  const STALE: RestResponse = {
    status: 409,
    body: { ok: false, error: 'vorschlag_stale', actionId: 'act_1', actionTool: 'issue_invoice' },
  };

  it('the Vorschläge queue: approving a Vorschlag whose record changed shows that nothing ran', async () => {
    let decided = false;
    const transport: Transport = async (action) => {
      if (action === 'list_agent_sessions') return { status: 200, body: { ok: true, sessions: [] } };
      if (action === 'list_drafted_actions') return { status: 200, body: { ok: true, actions: decided ? [] : [issueDraft] } };
      if (action === 'approve_drafted_action') {
        decided = true;
        return STALE;
      }
      return { status: 200, body: { ok: true } };
    };
    const { container } = wrap(<Agent />, transport);
    fireEvent.click(await screen.findByRole('tab', { name: 'Vorschläge' }));
    await screen.findAllByRole('article');
    fireEvent.click(screen.getByRole('button', { name: 'Genehmigen' }));
    const banner = await screen.findByText(/Nicht ausgeführt: Die Daten hinter diesem Vorschlag haben sich geändert/);
    expect(banner).toBeInTheDocument();
    expect(container.querySelector('.action-feedback--warn')).not.toBeNull();
    expect(container.querySelector('[data-just-committed]')).toBeNull();
    expect(screen.queryByText('Genehmigt und ausgeführt')).toBeNull();
    await waitFor(() => expect(screen.queryAllByRole('article')).toHaveLength(0));
  });

  it('the trace names a void proposal beside its drafting call', () => {
    const turn: AgentTurn = {
      turnId: 't1',
      seq: 1,
      role: 'agent',
      text: null,
      at: '2026-10-11T09:00:00.000Z',
      calls: [
        {
          callId: 'c1',
          seq: 1,
          verb: 'issue_invoice',
          kind: 'write',
          args: { invoiceId: 'doc_1' },
          mode: 'draft',
          decisionReason: 'dial_ask',
          dialCapability: 'issue',
          ok: true,
          errorCode: null,
          entityRef: null,
          durationMs: 3,
          at: '2026-10-11T09:00:00.000Z',
          agentActionId: 'act_1',
          draftStatus: 'stale',
          rejectReason: null,
        },
      ],
    };
    wrap(<Turn turn={turn} />);
    const decision = document.querySelector('[data-decision="stale"]');
    expect(decision?.textContent).toBe('Verfallen: nach dem Vorschlag geändert');
    expect(within(document.body).queryByText('Genehmigt')).toBeNull();
  });
});
