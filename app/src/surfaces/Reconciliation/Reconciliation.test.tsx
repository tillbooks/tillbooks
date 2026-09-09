/**
 * A21, Abgleich: the app-level suite, every GUI state.
 *
 * The canned queue payloads mirror the engine's real shapes, exercised end to end by
 * `test/banking/qr-match.test.mjs`; the option reads (bank accounts, saved views, open items) are
 * OTHER capabilities' verbs, canned by hand and asserted through what this surface renders from
 * them. The LOADING test proves its read with `transport.started(...)` per
 * `app/src/loading-state-convention.test.ts`. Confidence must be conveyed by glyph PLUS text
 * (never colour alone), the medium row must show the exact Rappen delta, and Override must be
 * reachable on EVERY row state, applied included (the US-A21.4 gap the spec rewrite closed).
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import accountsFixture from '../Accounts/list-accounts.fixture.json';
import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { hang, neverSettles, watchReads } from '../../test-transport';
import Reconciliation from './index';

type Canned = Record<string, RestResponse | ((input: Record<string, unknown>) => RestResponse)>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (body: { error: string } & Record<string, unknown>, status = 422): RestResponse => ({
  status,
  body: { ...body, ok: false },
});

function score(confidence: string, extra: Record<string, unknown> = {}) {
  return {
    confidence,
    reason: null,
    invoiceId: null,
    invoiceNumber: null,
    contactId: null,
    contactName: null,
    invoiceOpenMinor: null,
    creditedOpenMinor: null,
    dunningFeeMinor: null,
    totalDueMinor: null,
    deltaMinor: null,
    invoiceCurrency: null,
    reference: { kind: 'qrr', value: null, display: null, valid: true },
    ...extra,
  };
}

function credit(id: string, extra: Record<string, unknown> = {}) {
  return {
    creditId: id,
    bankTxnId: null,
    bankAccountId: 'ba_1',
    bankAccountName: 'PostFinance',
    amountMinor: 108100,
    currency: 'CHF',
    valueDate: '2026-03-01',
    payerName: 'Zahler AG',
    status: 'open',
    score: score('high', {
      reason: 'exact_open',
      invoiceId: 'doc_1',
      invoiceNumber: 'R-2026-0001',
      contactName: 'Zahler AG',
      invoiceOpenMinor: 108100,
      dunningFeeMinor: 0,
      totalDueMinor: 108100,
      deltaMinor: 0,
      invoiceCurrency: 'CHF',
      reference: { kind: 'qrr', value: '210000000003139471430009017', display: '21 00000 00003 13947 14300 09017', valid: true },
    }),
    invoiceId: 'doc_1',
    appliedMode: null,
    paymentId: null,
    reversedPaymentIds: [],
    decidedBy: null,
    decidedAt: null,
    createdBy: 'studio',
    createdAt: '2026-03-01T08:00:00.000Z',
    ...extra,
  };
}

const COUNTS = { open: 1, review: 0, unmatched: 0, applied: 0, dismissed: 0 };

// A36-U3: `preview_payment`'s reply, minimal to what the posting-preview renders (legs + currency +
// remainder). It is the read twin of the settlement `confirm_match` books, so the legs shown here ARE
// the legs it will post: 2000 Kreditoren debited, 1020 Bank credited, balanced, nothing left over.
const previewPaymentFixture = ok({
  direction: 'outgoing',
  date: '2026-07-01',
  amountMinor: 4000,
  currency: 'CHF',
  remainderMinor: 0,
  legs: [
    { accountId: 'acc_2000', accountNumber: '2000', accountLabel: 'Kreditoren', debitMinor: 4000, creditMinor: 0 },
    { accountId: 'acc_1020', accountNumber: '1020', accountLabel: 'Bank', debitMinor: 0, creditMinor: 4000 },
  ],
  error: null,
});

const OPTION_READS: Canned = {
  list_bank_accounts: ok({
    bankAccounts: [
      { id: 'ba_1', name: 'PostFinance', currency: 'CHF', archived: false, ledgerAccountId: 'acc_1020', ledgerAccountNumber: '1020' },
    ],
  }),
  list_saved_views: ok({ entityKind: 'reconciliation_match', savedViews: [] }),
  list_open_items: ok({ items: [] }),
  preview_payment: previewPaymentFixture,
};

function queueOf(items: unknown[], counts: Record<string, number> = COUNTS, autoApply = false): Canned {
  return {
    ...OPTION_READS,
    list_unmatched_incoming: ok({ items, counts, autoApply, writeOffThresholdMinor: 100, filtered: false }),
  };
}

function caps(held: readonly string[]): Capabilities {
  return {
    whoami: {
      actor: 'studio',
      provisioned: true,
      isMember: true,
      memberId: 'm1',
      userId: 'u1',
      role: 'custom',
      capabilities: [...held],
    },
    can: (capability) => held.includes(capability),
    refresh: () => undefined,
  };
}

interface RenderOptions {
  transport?: Transport;
  held?: readonly string[] | null;
  workspaceId?: string | null;
  route?: string;
}

function renderSurface(canned: Canned = queueOf([credit('qrm_1')]), options: RenderOptions = {}) {
  const { transport, held = null, workspaceId = 'ws_test' } = options;
  const client = new TillClient(transport ?? fakeTransport(canned));
  const path = options.route ?? '/reconciliation';
  const inner = (
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <TillClientProvider client={client}>
            <Reconciliation />
          </TillClientProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </MemoryRouter>
  );
  return render(
    held === null ? (
      inner
    ) : (
      <CapabilitiesContext.Provider value={caps(held)}>{inner}</CapabilitiesContext.Provider>
    ),
  );
}

describe('Reconciliation: the five states', () => {
  it('loading: the skeleton is a load in progress, proven by the read having started', async () => {
    const transport = watchReads(neverSettles);
    renderSurface(undefined, { transport });
    await transport.started('list_unmatched_incoming');
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('empty: no credits states what the surface is for and offers the record', async () => {
    renderSurface(queueOf([], { open: 0, review: 0, unmatched: 0, applied: 0, dismissed: 0 }));
    expect(await screen.findByText('Noch keine eingehenden Zahlungen im Abgleich')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Gutschrift erfassen' }).length).toBeGreaterThan(0);
  });

  it('error: a failed queue read renders the retry banner, never a stack trace', async () => {
    renderSurface({ ...OPTION_READS, list_unmatched_incoming: reject({ error: 'io_error' }, 500) });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('permission denied on the read renders the padlock panel', async () => {
    renderSurface({ ...OPTION_READS, list_unmatched_incoming: reject({ error: 'permission_denied' }, 403) });
    expect(
      await screen.findByText('Du brauchst Leserechte auf den Verkauf, um den Abgleich zu sehen.'),
    ).toBeInTheDocument();
  });

  it('happy: a high row shows glyph plus text and the apply control', async () => {
    renderSurface();
    const row = (await screen.findByText('R-2026-0001')).closest('tr') as HTMLElement;
    // Glyph PLUS text, never colour alone: the state cell carries the word and a labelled glyph.
    expect(within(row).getByText('Sicher')).toBeInTheDocument();
    expect(within(row).getByRole('img', { name: 'Sicher' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Übernehmen' })).toBeEnabled();
    expect(within(row).getByRole('button', { name: 'Korrigieren' })).toBeEnabled();
  });
});

describe('Reconciliation: the decisions', () => {
  it('a medium row opens the review lane with the exact Rappen delta; a loss ABOVE the threshold is never offered one-click', async () => {
    const medium = credit('qrm_2', {
      amountMinor: 100000,
      score: score('medium', {
        reason: 'amount_short',
        invoiceId: 'doc_1',
        invoiceNumber: 'R-2026-0001',
        contactName: 'Zahler AG',
        invoiceOpenMinor: 108100,
        dunningFeeMinor: 0,
        totalDueMinor: 108100,
        deltaMinor: -8100,
        invoiceCurrency: 'CHF',
      }),
    });
    renderSurface(queueOf([medium], { open: 1, review: 1, unmatched: 0, applied: 0, dismissed: 0 }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Prüfen' }));
    // The exact delta, as plain text through the shared money formatter.
    expect(screen.getByText(/CHF -81\.00/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Als Teilzahlung buchen' })).toBeEnabled();
    // F3: CHF 81.00 is 81x the CHF 1.00 threshold, so accept-as-full is NOT offered; the lane
    // names the loss and the ceiling and points at the deliberate route instead.
    expect(screen.queryByRole('button', { name: /Als vollständig akzeptieren/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Rest von CHF 81\.00 übersteigt die Ausbuchungsgrenze \(CHF 1\.00\)/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Unter Zahlungen erfassen' })).toBeInTheDocument();
  });

  it('a loss INSIDE the threshold offers accept-as-full with the loss named on the button (F3)', async () => {
    const medium = credit('qrm_2b', {
      amountMinor: 108050,
      score: score('medium', {
        reason: 'amount_short',
        invoiceId: 'doc_1',
        invoiceNumber: 'R-2026-0001',
        contactName: 'Zahler AG',
        invoiceOpenMinor: 108100,
        dunningFeeMinor: 0,
        totalDueMinor: 108100,
        deltaMinor: -50,
        invoiceCurrency: 'CHF',
      }),
    });
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const canned = queueOf([medium], { open: 1, review: 1, unmatched: 0, applied: 0, dismissed: 0 });
    const transport: Transport = async (action, input) => {
      calls.push({ action, input: input as Record<string, unknown> });
      if (action === 'apply_qr_match') return ok({ paymentId: 'pay_1', credit: medium });
      return fakeTransport(canned)(action, input);
    };
    renderSurface(undefined, { transport });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Prüfen' }));
    const acceptFull = screen.getByRole('button', { name: 'Als vollständig akzeptieren (CHF 0.50 Verlust)' });
    await user.click(acceptFull);
    await waitFor(() => {
      const applied = calls.find((c) => c.action === 'apply_qr_match');
      expect(applied?.input['mode']).toBe('full');
    });
  });

  it('a fee-bearing shortfall derives the loss from the PRINCIPAL alone, exactly what the engine forgives (N1)', async () => {
    // The critic's shape: a dunned invoice 50 Rappen short of principal + fee. The engine's full
    // mode writes off the PRINCIPAL shortfall (CHF 0.50); deriving the button from -deltaMinor
    // showed CHF 20.50 and hid the offer behind a ceiling the engine never reaches.
    const dunned = credit('qrm_2e', {
      amountMinor: 108050,
      score: score('medium', {
        reason: 'amount_short',
        invoiceId: 'doc_1',
        invoiceNumber: 'R-2026-0001',
        contactName: 'Zahler AG',
        invoiceOpenMinor: 108100,
        dunningFeeMinor: 2000,
        totalDueMinor: 110100,
        deltaMinor: -2050,
        invoiceCurrency: 'CHF',
      }),
    });
    renderSurface(queueOf([dunned], { open: 1, review: 1, unmatched: 0, applied: 0, dismissed: 0 }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Prüfen' }));
    expect(screen.getByRole('button', { name: 'Als vollständig akzeptieren (CHF 0.50 Verlust)' })).toBeEnabled();
    expect(screen.queryByText(/übersteigt die Ausbuchungsgrenze/)).not.toBeInTheDocument();
  });

  it('a currency mismatch renders NO review lane and points at Payments instead (F6)', async () => {
    const mismatch = credit('qrm_2c', {
      currency: 'EUR',
      score: score('medium', {
        reason: 'currency_differs',
        invoiceId: 'doc_1',
        invoiceNumber: 'R-2026-0001',
        contactName: 'Zahler AG',
        invoiceOpenMinor: 108100,
        dunningFeeMinor: 0,
        totalDueMinor: 108100,
        deltaMinor: null,
        invoiceCurrency: 'CHF',
      }),
    });
    renderSurface(queueOf([mismatch], { open: 1, review: 1, unmatched: 0, applied: 0, dismissed: 0 }));
    const row = (await screen.findByText('R-2026-0001')).closest('tr') as HTMLElement;
    // The mismatch is STATED (glyph + reason text) and the row's action is the surface that works.
    expect(within(row).getByText('Währung weicht von der Rechnung ab')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Prüfen' })).not.toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Unter Zahlungen erfassen' })).toHaveAttribute('href', '/payments');
  });

  it('an applied row shows the remaining open amount (F7)', async () => {
    const applied = credit('qrm_2d', {
      status: 'applied',
      appliedMode: 'partial',
      paymentId: 'pay_7',
      score: score('medium', {
        reason: 'amount_short',
        invoiceId: 'doc_1',
        invoiceNumber: 'R-2026-0001',
        contactName: 'Zahler AG',
        invoiceOpenMinor: 5000,
        totalDueMinor: 5000,
        invoiceCurrency: 'CHF',
      }),
    });
    renderSurface(queueOf([applied], { open: 0, review: 0, unmatched: 0, applied: 1, dismissed: 0 }));
    expect(await screen.findByText('Noch offen: CHF 50.00')).toBeInTheDocument();
  });

  it('applying a high row sends apply_qr_match with confirmed: true and mode full', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const canned = queueOf([credit('qrm_1')]);
    const transport: Transport = async (action, input) => {
      calls.push({ action, input: input as Record<string, unknown> });
      if (action === 'apply_qr_match') return ok({ paymentId: 'pay_1', credit: credit('qrm_1', { status: 'applied' }) });
      return fakeTransport(canned)(action, input);
    };
    renderSurface(undefined, { transport });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Übernehmen' }));
    await waitFor(() => {
      const applied = calls.find((c) => c.action === 'apply_qr_match');
      expect(applied).toBeDefined();
      expect(applied?.input['confirmed']).toBe(true);
      expect(applied?.input['mode']).toBe('full');
      expect(applied?.input['creditId']).toBe('qrm_1');
      expect(applied?.input['invoiceId']).toBe('doc_1');
    });
  });

  it('override is reachable on an APPLIED row and shows the audit stamp', async () => {
    const applied = credit('qrm_3', {
      status: 'applied',
      paymentId: 'pay_9',
      decidedBy: 'studio',
      decidedAt: '2026-03-02T09:00:00.000Z',
    });
    renderSurface(queueOf([applied], { open: 0, review: 0, unmatched: 0, applied: 1, dismissed: 0 }));
    const user = userEvent.setup();
    const row = (await screen.findByText('R-2026-0001')).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Korrigieren' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Verbucht von studio am 02\.03\.2026/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Zuordnung aufheben' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Keine Kundenzahlung' })).toBeEnabled();
  });

  it('permission denied pre-disables the decisions with a VISIBLE, described-by reason (a disabled title is not announced)', async () => {
    renderSurface(undefined, { held: ['read_sales'] });
    const row = (await screen.findByText('R-2026-0001')).closest('tr') as HTMLElement;
    const apply = within(row).getByRole('button', { name: 'Übernehmen' });
    expect(apply).toBeDisabled();
    // f2: the reason is no longer a (silent) title on the disabled button; it is a visible note the
    // button points at via aria-describedby, so assistive tech announces it.
    expect(apply).not.toHaveAttribute('title');
    expect(apply).toHaveAttribute('aria-describedby', 'qr-decide-denied');
    const note = document.getElementById('qr-decide-denied');
    expect(note).not.toBeNull();
    expect(note).toHaveTextContent('Erfordert die Berechtigung zum Buchen von Zahlungen');
    // The record button and the dial are pre-disabled and carry their own visible, described-by reason.
    const record = screen.getByRole('button', { name: 'Gutschrift erfassen' });
    expect(record).toBeDisabled();
    expect(record).toHaveAttribute('aria-describedby', 'qr-import-denied');
    expect(document.getElementById('qr-import-denied')).not.toBeNull();
    const dial = screen.getByRole('checkbox');
    expect(dial).toBeDisabled();
    expect(dial).toHaveAttribute('aria-describedby', 'qr-dial-denied');
    expect(document.getElementById('qr-dial-denied')).not.toBeNull();
  });

  it('f14: an open, unmatched row shows exactly ONE override control (Manuell zuordnen), not a duplicate Korrigieren', async () => {
    const unmatched = credit('qrm_um', {
      status: 'open',
      score: score('none'),
    });
    renderSurface(queueOf([unmatched], { open: 1, review: 0, unmatched: 1, applied: 0, dismissed: 0 }));
    // An unmatched row has no invoice number, so it is located by its payer.
    const row = (await screen.findByText('Zahler AG')).closest('tr') as HTMLElement;
    // The manual-match control is present; the redundant "Korrigieren" (same onOverride, same dialog)
    // is suppressed, so the operator is not shown two differently-labelled buttons for one action.
    expect(within(row).getByRole('button', { name: 'Manuell zuordnen' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Korrigieren' })).toBeNull();
  });

  it('the queue has no axe violations', async () => {
    const { container } = renderSurface();
    await screen.findByText('R-2026-0001');
    expect(await axe(container)).toHaveNoViolations();
  });
});

// --- A20's camt board -------------------------------------------------------------------------------

function camtRow(bankTxnId: string, extra: Record<string, unknown> = {}) {
  return {
    bankTxnId,
    bankAccountId: 'ba_1',
    entryRef: 'NTRY-1',
    amountMinor: 4000,
    currency: 'CHF',
    creditDebit: 'DBIT',
    valueDate: '2026-07-01',
    payerName: null,
    classification: 'outgoing_debit',
    status: 'unmatched',
    creditId: null,
    linkKind: null,
    linkTargetId: null,
    ...extra,
  };
}

function boardOf(
  unmatched: unknown[],
  matched: unknown[] = [],
  partial: unknown[] = [],
  reconciled: boolean | null = null,
): Canned {
  return {
    ...queueOf([], { open: 0, review: 0, unmatched: 0, applied: 0, dismissed: 0 }),
    list_reconciliation: ok({ matched, unmatched, partial, ...(reconciled === null ? {} : { reconciled }) }),
  };
}

describe('the statement list (F-03, J3.3): a door to every statement', () => {
  const STATEMENTS = {
    statements: [
      { statementId: 'bstmt_11', bankAccountId: 'ba_1', messageType: 'camt053', bankStatementId: 'SEED-CAMT-11', pageNumber: 1, fromDate: '2026-08-01', toDate: '2026-08-31', closingBalanceMinor: 1000, balanceCurrency: 'CHF', txnCount: 24, openCount: 20, reconciled: false, importedAt: '2026-09-01T08:00:00.000Z' },
      { statementId: 'bstmt_10', bankAccountId: 'ba_1', messageType: 'camt053', bankStatementId: 'SEED-CAMT-10', pageNumber: 1, fromDate: '2026-07-01', toDate: '2026-07-31', closingBalanceMinor: 900, balanceCurrency: 'CHF', txnCount: 18, openCount: 0, reconciled: true, importedAt: '2026-08-01T08:00:00.000Z' },
    ],
  };

  it('lists every imported statement with its open-line count, and opening one loads its board', async () => {
    const calls: string[] = [];
    const canned: Canned = { ...boardOf([camtRow('bt_1')]), list_bank_statements: ok(STATEMENTS) };
    const transport: Transport = async (action, input) => {
      calls.push(action);
      return fakeTransport(canned)(action, input);
    };
    renderSurface(undefined, { transport });
    const table = await screen.findByRole('table', { name: 'Kontoauszüge' });
    expect(within(table).getByText('20 offen')).toBeInTheDocument();
    expect(within(table).getByText('Alles zugeordnet')).toBeInTheDocument();
    // No statement is open yet: no board, no `list_reconciliation` read.
    expect(screen.queryByRole('heading', { name: 'Kontoauszug' })).toBeNull();
    expect(calls).not.toContain('list_reconciliation');
    const user = userEvent.setup();
    await user.click(within(table).getByRole('button', { name: 'Kontoauszug SEED-CAMT-11 öffnen' }));
    expect(await screen.findByRole('heading', { name: 'Kontoauszug' })).toBeInTheDocument();
    expect(await screen.findByText('NTRY-1')).toBeInTheDocument();
    await waitFor(() => expect(calls).toContain('list_reconciliation'));
  });

  // Critic F9: `statements` started as [] and the list rendered as soon as the queue had loaded, so
  // "Noch kein Kontoauszug importiert." flashed while list_bank_statements was still in flight.
  // Start it as [] again and the sentence is back.
  it('while list_bank_statements is in flight the list is a skeleton, never the empty sentence', async () => {
    const canned: Canned = { ...queueOf([credit('qrm_1')]), list_bank_statements: ok({ statements: [] }) };
    const transport = watchReads(hang('list_bank_statements', fakeTransport(canned)));
    renderSurface(undefined, { transport });
    // The skeleton is a load in progress, proven by the read having started (never a vacuous
    // assertion over the initial `loading` state).
    await transport.started('list_bank_statements');
    // The queue itself is loaded and rendered.
    expect(await screen.findByRole('heading', { name: 'Kontoauszüge' })).toBeInTheDocument();
    expect(screen.queryByText('Noch kein Kontoauszug importiert.')).toBeNull();
    const section = screen.getByRole('heading', { name: 'Kontoauszüge' }).closest('section') as HTMLElement;
    expect(within(section).getByRole('status')).toBeInTheDocument();
  });

  it('with nothing imported, the list is an honest empty state that offers the import', async () => {
    renderSurface({ ...queueOf([]), list_bank_statements: ok({ statements: [] }) });
    expect(await screen.findByText('Noch kein Kontoauszug importiert.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Kontoauszug importieren' }).length).toBeGreaterThan(0);
  });

  it('a line with no candidate says so on the row', async () => {
    const canned: Canned = {
      ...boardOf([camtRow('bt_9')]),
      suggest_matches: ok({ txns: [{ bankTxnId: 'bt_9', classification: 'outgoing_debit', proposal: null, needsReview: true }] }),
    };
    renderSurface(canned, { route: '/reconciliation?statement=stmt_1' });
    const row = (await screen.findByText('NTRY-1')).closest('tr') as HTMLElement;
    expect(within(row).getByText(/Kein Gegenstück gefunden/)).toBeInTheDocument();
  });
});

describe('the camt board', () => {
  it('a statement in the URL loads the board and renders its unmatched row with Confirm and Book', async () => {
    renderSurface(boardOf([camtRow('bt_1')]), { route: '/reconciliation?statement=stmt_1' });
    const row = (await screen.findByText('NTRY-1')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Offen')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Zuordnen' })).toBeEnabled();
    expect(within(row).getByRole('button', { name: 'Buchen' })).toBeEnabled();
  });

  it('a matched row shows the matched glyph plus text and no action', async () => {
    renderSurface(boardOf([], [camtRow('bt_2', { status: 'matched', linkKind: 'payment' })]), {
      route: '/reconciliation?statement=stmt_1',
    });
    const row = (await screen.findByText('NTRY-1')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Zugeordnet')).toBeInTheDocument();
    expect(within(row).getByRole('img', { name: 'Zugeordnet' })).toBeInTheDocument();
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
  });

  it('an incoming-credit row points at the A21 queue instead of offering an action here', async () => {
    renderSurface(
      boardOf([camtRow('bt_3', { creditDebit: 'CRDT', classification: 'incoming_credit', creditId: 'qrm_9' })]),
      { route: '/reconciliation?statement=stmt_1' },
    );
    const row = (await screen.findByText('NTRY-1')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Im Abgleich oben entscheiden')).toBeInTheDocument();
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
  });

  it('the reconciled indicator renders glyph plus text and reflects the engine flag exactly', async () => {
    renderSurface(boardOf([], [camtRow('bt_4', { status: 'matched' })], [], true), {
      route: '/reconciliation?statement=stmt_1',
    });
    await screen.findByText('NTRY-1');
    expect(screen.getByText('Mit dem Kontostand abgeglichen')).toBeInTheDocument();
  });

  // A36-U1: `list_vendor_bills` answers `{ bills: [{ id, ... }] }`. The earlier fixture hand-shaped
  // `{ vendorBills: [{ vendorBillId }] }`, the Studio's own guessed keys, so it passed while the live
  // engine sent a shape the picker dropped every row of. This fixture is the ENGINE's shape.
  const engineVendorBills = ok({
    bills: [
      { id: 'vb_1', vendorReference: 'LG-1', vendorName: 'Lieferant GmbH', openMinor: 4000, currency: 'CHF', status: 'posted', settlementStatus: 'unpaid' },
    ],
  });

  it('A36-U1: the confirm dialog populates its picker from an engine-shaped list_vendor_bills row', async () => {
    const canned: Canned = { ...boardOf([camtRow('bt_u1')]), list_vendor_bills: engineVendorBills };
    renderSurface(canned, { route: '/reconciliation?statement=stmt_1' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Zuordnen' }));
    const dialog = await screen.findByRole('dialog');
    const select = within(dialog).getByLabelText('Kreditorenrechnung') as HTMLSelectElement;
    // Two options: the "keine" placeholder plus the one open, posted bill the engine sent.
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
    expect(within(select).getByRole('option', { name: /LG-1/ })).toHaveValue('vb_1');
  });

  it('confirming a debit against a vendor bill sends confirm_match with vendorBillId', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const withBills: Canned = { ...boardOf([camtRow('bt_5')]), list_vendor_bills: engineVendorBills };
    const transport: Transport = async (action, input) => {
      calls.push({ action, input: input as Record<string, unknown> });
      if (action === 'confirm_match') return ok({ bankTxnId: 'bt_5', kind: 'payment', targetId: 'pay_1' });
      return fakeTransport(withBills)(action, input);
    };
    renderSurface(undefined, { transport, route: '/reconciliation?statement=stmt_1' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Zuordnen' }));
    const dialog = await screen.findByRole('dialog');
    const select = within(dialog).getByLabelText('Kreditorenrechnung');
    await user.selectOptions(select, 'vb_1');
    await user.click(within(dialog).getByRole('button', { name: 'Rechnung zuordnen' }));
    await waitFor(() => {
      const confirmed = calls.find((c) => c.action === 'confirm_match');
      expect(confirmed?.input['bankTxnId']).toBe('bt_5');
      expect(confirmed?.input['vendorBillId']).toBe('vb_1');
    });
  });

  const vendorBillSuggestion = (bankTxnId: string) =>
    ok({
      txns: [
        {
          bankTxnId,
          classification: 'outgoing_debit',
          proposal: { kind: 'vendor_bill', targetId: 'vb_1', confidence: 'high', reason: 'exact_amount', signals: ['amount', 'value_date'] },
          needsReview: false,
        },
      ],
    });

  it('A36-U3: a vendor_bill suggestion NAMES its target on the row, not only its reasons', async () => {
    const canned: Canned = {
      ...boardOf([camtRow('bt_t1')]),
      list_vendor_bills: engineVendorBills,
      suggest_matches: vendorBillSuggestion('bt_t1'),
    };
    renderSurface(canned, { route: '/reconciliation?statement=stmt_1' });
    const row = (await screen.findByText('NTRY-1')).closest('tr') as HTMLElement;
    // The WHAT (the proposed bill's identity) rides beside the WHY (the reason words).
    await waitFor(() => expect(within(row).getByText(/Vorschlag: LG-1 · Lieferant GmbH/)).toBeInTheDocument());
    expect(within(row).getByText('genauer Betrag, Valuta innerhalb des Fensters')).toBeInTheDocument();
  });

  it('A36-U3: the confirm dialog previews the posting legs and names the target before Zuordnen books', async () => {
    const canned: Canned = {
      ...boardOf([camtRow('bt_p1')]),
      list_vendor_bills: engineVendorBills,
      suggest_matches: vendorBillSuggestion('bt_p1'),
    };
    renderSurface(canned, { route: '/reconciliation?statement=stmt_1' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Zuordnen' }));
    const dialog = await screen.findByRole('dialog');
    // The proposed bill is pre-selected, so the preview loads without a manual pick.
    await within(dialog).findByText('Buchungsvorschau');
    expect(within(dialog).getByText(/Zielbeleg: LG-1 · Lieferant GmbH/)).toBeInTheDocument();
    expect(within(dialog).getByText('2000 Kreditoren')).toBeInTheDocument();
    expect(within(dialog).getByText('1020 Bank')).toBeInTheDocument();
    expect(within(dialog).getByText('Soll CHF 40.00')).toBeInTheDocument();
    expect(within(dialog).getByText('Haben CHF 40.00')).toBeInTheDocument();
  });

  it('A36-U3: the Werkbank books a debit through confirm_match with allocations, preserving the statement-line link', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const withBills: Canned = {
      ...boardOf([camtRow('bt_w1', { amountMinor: 4000 })]),
      list_vendor_bills: engineVendorBills,
    };
    const transport: Transport = async (action, input) => {
      calls.push({ action, input: input as Record<string, unknown> });
      if (action === 'confirm_match') return ok({ bankTxnId: 'bt_w1', kind: 'payment', targetId: 'pay_9' });
      return fakeTransport(withBills)(action, input);
    };
    renderSurface(undefined, { transport, route: '/reconciliation?statement=stmt_1' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Aufteilen' }));
    const dialog = await screen.findByRole('dialog', { name: 'Bewegung aufteilen' });
    const alloc = within(dialog).getByLabelText('Zuteilen LG-1');
    await user.clear(alloc);
    await user.type(alloc, '40.00');
    const book = within(dialog).getByRole('button', { name: 'Buchen' });
    await waitFor(() => expect(book).toBeEnabled());
    await user.click(book);
    await waitFor(() => {
      const confirmed = calls.find((c) => c.action === 'confirm_match');
      // The bank statement line (bankTxnId) still rides on confirm_match, so the same bank_txn_link is
      // written and the line ends up matched, exactly as the fast path does.
      expect(confirmed?.input['bankTxnId']).toBe('bt_w1');
      expect(confirmed?.input['allocations']).toEqual([{ vendorBillId: 'vb_1', amountMinor: 4000 }]);
    });
  });

  it('booking an unmatched txn sends create_entry_for_txn with the chosen contra account', async () => {
    // The recorded chart (`list-accounts.fixture.json`), pinned to the live `list_accounts` answer:
    // no account row here is hand-typed (`test/accounts/studio-list-accounts-fixture.test.mjs`).
    const contra = accountsFixture.accounts.find((a) => a.number === '6500');
    if (contra === undefined) throw new Error('the chart recording has no account 6500');
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const canned = boardOf([camtRow('bt_6')]);
    const withAccounts: Canned = { ...canned, list_accounts: ok(accountsFixture) };
    const transport: Transport = async (action, input) => {
      calls.push({ action, input: input as Record<string, unknown> });
      if (action === 'create_entry_for_txn') return ok({ bankTxnId: 'bt_6', entryId: 'e_1' });
      return fakeTransport(withAccounts)(action, input);
    };
    renderSurface(undefined, { transport, route: '/reconciliation?statement=stmt_1' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Buchen' }));
    const dialog = await screen.findByRole('dialog');
    // F-03 (J3.7 / J3.3): the contra account is typed by number, and the Buchungsvorschau renders
    // the two legs before anything posts (the bank leg on the account's ledger link, the contra leg).
    const picker = within(dialog).getByRole('combobox', { name: 'Gegenkonto' });
    await user.type(picker, contra.number);
    await user.keyboard('{Enter}');
    expect(within(dialog).getByText('Buchungsvorschau')).toBeInTheDocument();
    expect(within(dialog).getByText(`${contra.number} ${contra.name}`)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => {
      const booked = calls.find((c) => c.action === 'create_entry_for_txn');
      expect(booked?.input['bankTxnId']).toBe('bt_6');
      expect(booked?.input['contraAccountId']).toBe(contra.id);
    });
  });

  // Critic F6 (M2): a per-render key passed every test here. The key exists for a write that LANDED
  // whose response was lost: the retry must carry the SAME key so the engine replays instead of
  // booking a second entry. A description typed between the two presses re-renders the dialog and
  // must not mint a new key either. Swap `useIdempotencyKey` for a per-render uuid and this fails.
  it('Buchen retried after a lost response carries the SAME idempotency key (one entry, never two)', async () => {
    const contra = accountsFixture.accounts.find((a) => a.number === '6500');
    if (contra === undefined) throw new Error('the chart recording has no account 6500');
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const withAccounts: Canned = { ...boardOf([camtRow('bt_6')]), list_accounts: ok(accountsFixture) };
    let attempts = 0;
    const transport: Transport = async (action, input) => {
      calls.push({ action, input: input as Record<string, unknown> });
      if (action === 'create_entry_for_txn') {
        attempts += 1;
        // The first attempt landed on the engine but the answer was lost on the wire.
        if (attempts === 1) return { status: 0, body: { ok: false, error: 'transport_error' } };
        return ok({ bankTxnId: 'bt_6', entryId: 'e_1' });
      }
      return fakeTransport(withAccounts)(action, input);
    };
    renderSurface(undefined, { transport, route: '/reconciliation?statement=stmt_1' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Buchen' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox', { name: 'Gegenkonto' }), contra.number);
    await user.keyboard('{Enter}');
    await user.click(within(dialog).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(calls.filter((c) => c.action === 'create_entry_for_txn')).toHaveLength(1));
    // The refusal is shown, the dialog stays, the person edits the description and presses again.
    expect(await within(dialog).findByText('Die Buchung ist fehlgeschlagen.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Beschreibung'), 'Bankspesen');
    await user.click(within(dialog).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(calls.filter((c) => c.action === 'create_entry_for_txn')).toHaveLength(2));
    const [first, second] = calls.filter((c) => c.action === 'create_entry_for_txn');
    expect(typeof first?.input['idempotencyKey']).toBe('string');
    expect(second?.input['idempotencyKey']).toBe(first?.input['idempotencyKey']);
    expect(second?.input['contraAccountId']).toBe(contra.id);
  });

  it('permission denied pre-disables Confirm and Book, never shown-then-rejected', async () => {
    renderSurface(boardOf([camtRow('bt_7')]), { held: ['read_sales'], route: '/reconciliation?statement=stmt_1' });
    const row = (await screen.findByText('NTRY-1')).closest('tr') as HTMLElement;
    const confirm = within(row).getByRole('button', { name: 'Zuordnen' });
    expect(confirm).toBeDisabled();
    // f2: the reason is a visible, described-by note, not a silent title on the disabled button.
    expect(confirm).not.toHaveAttribute('title');
    expect(confirm).toHaveAttribute('aria-describedby', 'camt-decide-denied');
    const note = document.getElementById('camt-decide-denied');
    expect(note).not.toBeNull();
    expect(note).toHaveTextContent('Erfordert die Berechtigung zum Buchen von Zahlungen');
    expect(within(row).getByRole('button', { name: 'Buchen' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Kontoauszug importieren' })).toBeDisabled();
  });

  it('the camt board has no axe violations', async () => {
    const { container } = renderSurface(boardOf([camtRow('bt_8')], [camtRow('bt_9', { status: 'matched' })]), {
      route: '/reconciliation?statement=stmt_1',
    });
    await screen.findAllByText('NTRY-1');
    expect(await axe(container)).toHaveNoViolations();
  });
});

// --- A36's ranked-debit suggestions, layered onto the camt board's own rows -----------------------

describe('the camt board: A36 ranked suggestions', () => {
  it('a vendor_bill proposal renders its matched signals in words', async () => {
    const canned: Canned = {
      ...boardOf([camtRow('bt_10')]),
      suggest_matches: ok({
        txns: [
          {
            bankTxnId: 'bt_10',
            classification: 'outgoing_debit',
            proposal: {
              kind: 'vendor_bill',
              targetId: 'vb_1',
              confidence: 'high',
              reason: 'reference_match',
              signals: ['amount', 'value_date', 'reference'],
            },
            needsReview: false,
          },
        ],
      }),
    };
    renderSurface(canned, { route: '/reconciliation?statement=stmt_1' });
    const row = (await screen.findByText('NTRY-1')).closest('tr') as HTMLElement;
    await waitFor(() =>
      expect(within(row).getByText('genauer Betrag, Valuta innerhalb des Fensters, Referenz stimmt überein')).toBeInTheDocument(),
    );
  });

  it('A36-U5: a needsReview txn shows the needs-review signal as a visible word beside the glyph, not glyph alone', async () => {
    const canned: Canned = {
      ...boardOf([camtRow('bt_11')]),
      suggest_matches: ok({
        txns: [{ bankTxnId: 'bt_11', classification: 'outgoing_debit', proposal: null, needsReview: true }],
      }),
    };
    renderSurface(canned, { route: '/reconciliation?statement=stmt_1' });
    const row = (await screen.findByText('NTRY-1')).closest('tr') as HTMLElement;
    // The visible word rides beside the glyph, like every other status; the full sentence is the tooltip.
    const signal = await within(row).findByText('Zu prüfen');
    expect(signal).toHaveAttribute('title', 'Zu prüfen: kein Vorschlag erreicht die Prüfschwelle');
    // The needs-review glyph is decorative now: its meaning is the visible word, not an image whose
    // accessible name silently carries the whole sentence (the A36-U5 defect).
    expect(
      within(row).queryByRole('img', { name: 'Zu prüfen: kein Vorschlag erreicht die Prüfschwelle' }),
    ).not.toBeInTheDocument();
  });

  it('an unblocked payment_batch proposal renders Sammelzahlung and the one-click confirm calls mark_batch_paid', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const canned: Canned = {
      ...boardOf([camtRow('bt_12', { valueDate: '2026-07-05' })]),
      suggest_matches: ok({
        txns: [
          {
            bankTxnId: 'bt_12',
            classification: 'outgoing_debit',
            proposal: { kind: 'payment_batch', targetId: 'batch_1', confidence: 'high', reason: 'batch', signals: ['batch'], blocked: false },
            needsReview: false,
          },
        ],
      }),
    };
    const transport: Transport = async (action, input) => {
      calls.push({ action, input: input as Record<string, unknown> });
      if (action === 'mark_batch_paid') return ok({ batchId: 'batch_1' });
      return fakeTransport(canned)(action, input);
    };
    renderSurface(undefined, { transport, route: '/reconciliation?statement=stmt_1' });
    const row = (await screen.findByText('NTRY-1')).closest('tr') as HTMLElement;
    await screen.findByText('Sammelzahlung');
    const confirmBatch = within(row).getByRole('button', { name: 'Sammelzahlung bestätigen' });
    expect(confirmBatch).toBeEnabled();
    await userEvent.click(confirmBatch);
    await waitFor(() => {
      const confirmed = calls.find((c) => c.action === 'mark_batch_paid');
      expect(confirmed?.input['batchId']).toBe('batch_1');
      expect(confirmed?.input['confirmation']).toBe(true);
      expect(confirmed?.input['valueDate']).toBe('2026-07-05');
    });
  });

  it('a blocked batch-total mismatch shows both figures side by side and disables the one-click confirm', async () => {
    const canned: Canned = {
      ...boardOf([camtRow('bt_13', { amountMinor: 5000 })]),
      suggest_matches: ok({
        txns: [
          {
            bankTxnId: 'bt_13',
            classification: 'outgoing_debit',
            proposal: {
              kind: 'payment_batch',
              targetId: 'batch_2',
              confidence: 'medium',
              reason: 'batch',
              signals: ['batch', 'batch_total_mismatch'],
              blocked: true,
            },
            needsReview: true,
          },
        ],
      }),
      get_payment_batch: ok({ batch: { id: 'batch_2', ctrlSumMinor: 6000 } }),
    };
    renderSurface(canned, { route: '/reconciliation?statement=stmt_1' });
    const row = (await screen.findByText('NTRY-1')).closest('tr') as HTMLElement;
    await waitFor(() => expect(within(row).getByText(/CHF 50\.00 \/ CHF 60\.00/)).toBeInTheDocument());
    const confirmBatch = within(row).getByRole('button', { name: 'Sammelzahlung bestätigen' });
    expect(confirmBatch).toBeDisabled();
    // The manual split stays reachable: Zuordnen (confirm_match, which accepts allocations[]) never
    // disappears just because the one-click batch confirm cannot fire.
    expect(within(row).getByRole('button', { name: 'Zuordnen' })).toBeEnabled();
  });
});
